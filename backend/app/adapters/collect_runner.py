"""Collection runners — fixture replay offline, n8n-driven collection when connected. / 수집 러너 어댑터.

캐스케이드(객체 → 그 객체의 컬럼 → 키 → …)는 **백엔드가 주도한다**. n8n은 kind 하나에
쿼리 하나를 실행하는 단문 실행기(W1, 3노드)일 뿐이라 상태·분기를 갖지 않는다.
The backend owns the cascade; n8n only runs one small query per call.
"""

import json
import logging
import math
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol
from urllib.error import URLError

from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.schemas.ingest import CatalogPayload, ViewDepsPayload

logger = logging.getLogger(__name__)

# 일시 오류 1회 재시도 — 로깅 후 마지막 오류를 올린다 (n8n_query와 동일 관용)
RETRY_COUNT = 1


class CollectRunner(Protocol):
    """단계 실행 계약 — 완료 표시는 ingest 경로(update_collect_job)가 담당."""

    def run_catalog(self, job_id: int) -> None: ...

    def run_view_deps(self, job_id: int, snapshot_id: int) -> None: ...


class FixtureCollectRunner:
    """픽스처 페이로드를 ingest와 같은 코드 경로로 적재 — 오프라인 버튼 검증용.
    Replays fixture payloads through the real ingest path for offline testing."""

    def __init__(self, session_factory: sessionmaker, fixture_dir: str | Path) -> None:
        self._session_factory = session_factory
        self._fixture_dir = Path(fixture_dir)

    def _load(self, name: str) -> dict:
        path = self._fixture_dir / name
        # 픽스처는 gitignore 대상이라 배포 이미지에 없다 — 원인·조치를 잡 오류로 남긴다
        # fixtures are gitignored, so a container has none; say what to do instead of ENOENT
        if not path.exists():
            raise RuntimeError(
                f"fixture {path} not found (cwd {Path.cwd()}) — real collection needs "
                "N8N_WEBHOOK_BASE; for offline replay generate fixtures first "
                f"(python tools/fixture_gen.py --out {self._fixture_dir})"
            )
        return json.loads(path.read_text())

    def run_catalog(self, job_id: int) -> None:
        # 순환 import 회피 — ingest는 이 어댑터의 팩토리를 모른다 / avoid circular import
        from app.api.ingest import ingest_catalog

        payload = CatalogPayload.model_validate(
            {**self._load("catalog.json"), "collect_job_id": job_id}
        )
        with self._session_factory() as db:
            ingest_catalog(payload, db)
            db.commit()

    def run_view_deps(self, job_id: int, snapshot_id: int) -> None:
        from app.api.ingest import ingest_view_deps

        payload = ViewDepsPayload.model_validate({
            **self._load("view_deps.json"),
            "snapshot_id": snapshot_id, "collect_job_id": job_id,
        })
        with self._session_factory() as db:
            ingest_view_deps(payload, db)
            db.commit()


def _group_key_constraints(rows: list[dict]) -> list[dict]:
    """행 단위 PK/UQ를 제약 단위로 묶는다 / group key-constraint rows by name."""
    grouped: dict[str, dict] = {}
    for row in rows:
        name = row.get("name")
        if not name:
            continue
        entry = grouped.setdefault(name, {
            "name": name, "type": row["type"], "object_id": row["object_id"], "columns": [],
        })
        entry["columns"].append(row["column_name"])
    return list(grouped.values())


def _group_foreign_keys(rows: list[dict]) -> list[dict]:
    grouped: dict[str, dict] = {}
    for row in rows:
        name = row.get("name")
        if not name:
            continue
        entry = grouped.setdefault(name, {
            "name": name, "src_object_id": row["src_object_id"],
            "tgt_object_id": row["tgt_object_id"], "columns": [],
        })
        entry["columns"].append(
            {"src_column": row["src_column"], "tgt_column": row["tgt_column"]})
    return list(grouped.values())


def _build_view_deps(refs: list[dict], deps: list[dict]) -> dict:
    """07 컬럼 단위 우선, 06은 미해석·DMV 실패 뷰 보강 (계약 규칙, 판단 아님)."""
    failures = [{"object_id": r["view_object_id"], "reason": r["reason"]}
                for r in refs if r.get("kind") == "failure"]
    failed_ids = {f["object_id"] for f in failures}
    resolved = [{
        "view_object_id": r["view_object_id"],
        "referenced_object_id": r["referenced_object_id"],
        "referenced_database": r.get("referenced_database"),
        "referenced_name": r.get("referenced_name"),
        "referenced_column": r.get("referenced_column"),
        "is_resolved": True,
    } for r in refs if r.get("kind") == "dep" and r.get("is_resolved")]
    fallback = [{**d, "is_resolved": bool(d.get("is_resolved"))} for d in deps
                if d.get("view_object_id") is not None
                and (not d.get("is_resolved") or d["view_object_id"] in failed_ids)]
    return {"deps": resolved + fallback, "unresolved_objects": failures}


class N8nCollectRunner:
    """W1 단문 실행기를 순차 호출해 카탈로그를 조립한다 / drives the cascade over W1.

    한 번의 호출은 쿼리 하나(객체 한 페이지, 그 페이지 객체들의 컬럼 등)만 수행하므로
    소스 DB 점유·n8n 메모리·응답 크기가 페이지 크기로 묶인다. 적재는 픽스처 경로와
    같은 ingest 함수를 쓴다 — 계약이 하나뿐이라 오프라인 테스트가 실경로를 덮는다.
    """

    def __init__(
        self, webhook_base: str, session_factory: sessionmaker,
        catalog_chunk_size: int = 300, deps_chunk_size: int = 100,
        query_timeout: int = 120,
    ) -> None:
        self._base = webhook_base.rstrip("/")
        self._session_factory = session_factory
        self._catalog_chunk_size = catalog_chunk_size
        self._deps_chunk_size = deps_chunk_size
        self._timeout = query_timeout

    def _query(self, kind: str, params: dict | None = None) -> list[dict]:
        """W1에 kind 하나를 요청하고 행을 받는다 / one small query, rows back."""
        body = {"kind": kind, **(params or {})}
        request = urllib.request.Request(
            f"{self._base}/dbv-catalog",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        last_error: Exception | None = None
        for attempt in range(RETRY_COUNT + 1):
            try:
                with urllib.request.urlopen(request, timeout=self._timeout) as response:
                    payload = json.loads(response.read().decode())
                rows = payload if isinstance(payload, list) else [payload]
                # alwaysOutputData가 0건을 빈 아이템 하나로 보낸다 / normalize the empty item
                return [r for r in rows if r]
            except URLError as e:
                last_error = e
                logger.warning("catalog query attempt failed",
                               extra={"kind": kind, "attempt": attempt})
        raise RuntimeError(f"catalog query failed after retries: kind={kind}") from last_error

    def run_catalog(self, job_id: int) -> None:
        """객체 페이지마다 객체 → 컬럼 → 키 → 뷰 정의를 각각 별도 쿼리로 받아 적재한다."""
        from app.api.ingest import ingest_catalog, update_collect_job

        totals = self._query("totals")
        object_total = int(totals[0]["object_total"]) if totals else 0
        page_size = self._catalog_chunk_size
        chunk_total = max(1, math.ceil(object_total / page_size))

        for index in range(1, chunk_total + 1):
            objects = self._query("objects", {
                "offset": (index - 1) * page_size, "limit": page_size,
            })
            ids = [int(o["object_id"]) for o in objects]
            view_ids = [int(o["object_id"]) for o in objects if o.get("type") == "view"]
            payload = CatalogPayload.model_validate({
                "collect_job_id": job_id,
                "source_db": "MSSQL",
                "collected_at": datetime.now(UTC).isoformat(),
                "chunk_index": index, "chunk_total": chunk_total,
                "objects": objects,
                "columns": self._query("columns", {"object_ids": ids}) if ids else [],
                "key_constraints": _group_key_constraints(
                    self._query("key_constraints", {"object_ids": ids}) if ids else []),
                # FK는 객체 페이지를 가로지른다 — 전 객체가 적재된 마지막 페이지에서만
                "foreign_keys": (_group_foreign_keys(self._query("foreign_keys"))
                                 if index == chunk_total else []),
                "view_definitions": (
                    self._query("view_definitions", {"object_ids": view_ids})
                    if view_ids else []),
            })
            with self._session_factory() as db:
                ingest_catalog(payload, db)
                db.commit()

        if object_total == 0:  # 객체 0건이면 ingest가 돌지 않는다 — 잡은 닫아야 한다
            with self._session_factory() as db:
                update_collect_job(db, job_id, "catalog_done", counts={"objects": 0})
                db.commit()

    def run_view_deps(self, job_id: int, snapshot_id: int) -> None:
        """뷰를 배치로 나눠 의존·참조 쿼리를 각각 호출한다 (DMV 커서 배치 크기 통제)."""
        from app.api.ingest import ingest_view_deps
        from app.models import CatalogObject

        with self._session_factory() as db:
            view_ids = list(db.execute(
                select(CatalogObject.object_id)
                .where(CatalogObject.snapshot_id == snapshot_id,
                       CatalogObject.type == "view")
                .order_by(CatalogObject.object_id)
            ).scalars())

        batch = self._deps_chunk_size
        chunk_total = max(1, math.ceil(len(view_ids) / batch))
        for index in range(1, chunk_total + 1):
            ids = view_ids[(index - 1) * batch: index * batch]
            refs = self._query("view_refs", {"object_ids": ids}) if ids else []
            deps = self._query("view_deps", {"object_ids": ids}) if ids else []
            payload = ViewDepsPayload.model_validate({
                "snapshot_id": snapshot_id, "collect_job_id": job_id,
                "chunk_index": index, "chunk_total": chunk_total,
                **_build_view_deps(refs, deps),
            })
            with self._session_factory() as db:
                ingest_view_deps(payload, db)
                db.commit()
