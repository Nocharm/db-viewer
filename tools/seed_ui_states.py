"""Prime every UI visual state for local UI/UX review. / UI 리허설용 상태 프라이밍.

픽스처 적재 위에 T2 검증·확정·AI 제안·요약·화이트리스트를 API로 실행해
ERD 엣지 6종, confidence 투명도 단계, 배지, 관리 화면 데이터를 만든다.
어디서 무엇을 보는지는 docs/ui-review.md 체크리스트 참조.

Usage: python tools/seed_ui_states.py [--base http://localhost:8000] [--fixtures fixtures]
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ADMIN = {"X-Dev-User": "admin.sys"}  # auth OFF 개발 모드 전용 / dev-mode identity


def call(base: str, method: str, path: str, payload: dict | None = None,
         headers: dict | None = None) -> dict:
    request = urllib.request.Request(
        f"{base}{path}", method=method,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path} failed: {e.code} {e.read().decode()[:300]}") from e


def find_object_id(base: str, qname: str) -> int:
    schema, name = qname.split(".", 1)
    items = call(base, "GET", f"/api/objects?q={name}")["items"]
    for item in items:
        if item["schema"] == schema and item["name"] == name:
            return item["id"]
    raise SystemExit(f"object not found: {qname}")


def find_column_id(base: str, qname: str, column: str) -> int:
    object_id = find_object_id(base, qname)
    detail = call(base, "GET", f"/api/objects/{object_id}/detail")
    for col in detail["columns"]:
        if col["name"] == column:
            return col["id"]
    raise SystemExit(f"column not found: {qname}.{column}")


def pick_relations(fixtures: Path) -> dict:
    rows = json.loads((fixtures / "expected/relations.json").read_text())["rows"]
    clean = [r for r in rows if r["kind"] == "real_no_fk" and r["orphan_count"] == 0]
    mid = [r for r in rows if 0.95 <= r["containment"] < 0.995]
    low = [r for r in rows if r["containment"] < 0.95]
    if len(clean) < 2:
        raise SystemExit("fixture lacks clean real_no_fk relations")
    return {
        "confirm": clean[0],           # ✓ confirmed 실선
        "high": clean[1],              # 3회 검증 — 관측 누적 confidence
        "orphan_mid": mid[0] if mid else None,   # 파선 투명도 0.7 대역
        "orphan_low": low[0] if low else None,   # 파선 투명도 0.45 대역
    }


def validate_pair(base: str, rel: dict, times: int = 1) -> dict:
    src = find_column_id(base, rel["src_object"], rel["src_column"])
    tgt = find_column_id(base, rel["tgt_object"], rel["tgt_column"])
    result: dict = {}
    for _ in range(times):
        result = call(base, "POST", "/api/validate/containment", {
            "src_column_id": src, "tgt_column_id": tgt, "triggered_by": "ui-seed",
        })
    result["_src_column_id"], result["_tgt_column_id"] = src, tgt
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://localhost:8000")
    parser.add_argument("--fixtures", type=Path, default=Path("fixtures"))
    args = parser.parse_args()
    base = args.base

    # 스냅샷 없으면 픽스처 먼저 적재 / ingest fixtures when the stack is empty
    snapshots = call(base, "GET", "/api/snapshots")["items"]
    if not any(s["status"] == "ready" for s in snapshots):
        if not (args.fixtures / "catalog.json").exists():
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            import fixture_gen

            fixture_gen.generate(seed=42, out_dir=args.fixtures)
        catalog = json.loads((args.fixtures / "catalog.json").read_text())
        result = call(base, "POST", "/api/ingest/catalog", catalog)
        view_deps = json.loads((args.fixtures / "view_deps.json").read_text())
        view_deps["snapshot_id"] = result["snapshot_id"]
        call(base, "POST", "/api/ingest/view-deps", view_deps)
        print(f"ingested snapshot {result['snapshot_id']}")

    rels = pick_relations(args.fixtures)

    confirmed = validate_pair(base, rels["confirm"])
    call(base, "POST", "/api/relations/confirm", {
        "src_column_id": confirmed["_src_column_id"],
        "tgt_column_id": confirmed["_tgt_column_id"],
        "confirmed_by": "ui-seed",
    })
    print(f"confirmed: {rels['confirm']['src_object']}.{rels['confirm']['src_column']} "
          f"→ {rels['confirm']['tgt_object']}.{rels['confirm']['tgt_column']}")

    high = validate_pair(base, rels["high"], times=3)
    print(f"inferred(3회 관측, confidence {high['confidence']}): "
          f"{rels['high']['src_object']}.{rels['high']['src_column']}")

    for key in ("orphan_mid", "orphan_low"):
        if rels[key]:
            result = validate_pair(base, rels[key])
            print(f"inferred({key}, containment {result['containment']}, "
                  f"confidence {result['confidence']}): "
                  f"{rels[key]['src_object']}.{rels[key]['src_column']}")

    # 202 + job_id로 바뀐 뒤로 여기서 KeyError로 죽어, 뒤따르는 AI 요약·화이트리스트
    # 시딩까지 통째로 건너뛰고 있었다 — 완료까지 폴링해 엣지가 실제로 생긴 뒤 넘어간다.
    # / this endpoint became async (202 + job_id); the old ['created'] lookup raised and
    #   took the AI-summary and whitelist seeding down with it. Poll until it finishes.
    job_id = call(base, "POST", "/api/ai/suggest-relations")["job_id"]
    for _ in range(120):
        job = call(base, "GET", f"/api/ai/jobs/{job_id}")
        if job["status"] in ("done", "failed"):
            break
        time.sleep(1)
    else:
        raise SystemExit(f"ai suggest job {job_id} did not finish in 120s")
    if job["status"] == "failed":
        raise SystemExit(f"ai suggest job {job_id} failed: {job.get('error')}")
    print(f"ai_suggested edges: job {job_id} {job['status']} "
          f"({job.get('created', job.get('processed', '?'))})")

    for qname in (rels["confirm"]["src_object"], rels["confirm"]["tgt_object"]):
        summary = call(base, "POST", f"/api/ai/summarize/{find_object_id(base, qname)}")
        print(f"ai summary: {summary['object']} (cached={summary['cached']})")

    for login_id, note in (("hong.gil", "UI 리뷰용"), ("kim.chulsoo", None)):
        call(base, "POST", "/api/admin/whitelist",
             {"login_id": login_id, "note": note}, headers=ADMIN)
    print("whitelist: hong.gil, kim.chulsoo")

    # 결과 확인 — 확정 관계가 읽기 전용 ERD에 실제로 반영됐는지 / verify it surfaces in the read-only ERD
    anchor_id = find_object_id(base, rels["confirm"]["src_object"])
    erd = call(base, "GET", "/api/erd")
    kinds = sorted({e["kind"] for e in erd["edges"]
                    if anchor_id in (e["src_object_id"], e["tgt_object_id"])})
    print(f"\n앵커 {rels['confirm']['src_object']} (id {anchor_id}) ERD 엣지 종류: {kinds}")
    print("→ 검색창에 위 테이블명을 넣고 시작하세요. 체크리스트: docs/ui-review.md")


if __name__ == "__main__":
    main()
