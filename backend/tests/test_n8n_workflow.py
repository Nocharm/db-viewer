"""n8n 워크플로 JSON 정합성 테스트 / workflow JSON consistency tests.

핵심 계약: n8n은 **단문 쿼리 실행기**다 — 워크플로는 짧게 유지하고, 캐스케이드는
백엔드(N8nCollectRunner)가 주도한다. 정찰(W0)만 사람이 UI에서 한 번 돌리는 예외다.
"""

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import build_n8n_workflow  # noqa: E402

RECON_PATH = REPO_ROOT / "n8n" / "workflows" / "w0_recon_queries.json"
W1_PATH = REPO_ROOT / "n8n" / "workflows" / "w1_catalog_query.json"
W2_PATH = REPO_ROOT / "n8n" / "workflows" / "w2_query_executor.json"
EXECUTORS = (W1_PATH, W2_PATH)


def _load(path: Path) -> dict:
    return json.loads(path.read_text())


def test_committed_workflows_match_regeneration():
    # SQL 파일이 단일 소스 — 커밋본과 재생성본이 다르면 드리프트 / drift guard
    assert _load(RECON_PATH) == build_n8n_workflow.build_recon_workflow()
    assert _load(W1_PATH) == build_n8n_workflow.build_catalog_query_workflow()
    assert _load(W2_PATH) == build_n8n_workflow.build_query_executor_workflow()


def test_workflow_files_are_exactly_the_generated_set():
    """생성기가 쓰는 파일 외에 워크플로 JSON이 남아 있으면 안 된다 (구 캐스케이드 잔재 방지)."""
    on_disk = {p.name for p in (REPO_ROOT / "n8n" / "workflows").glob("*.json")}
    assert on_disk == {RECON_PATH.name, W1_PATH.name, W2_PATH.name}


def test_executors_are_short_and_stateless():
    """단문 실행기 계약 — webhook → Code → MSSQL, 동기 응답, 체인 하나.
    W2는 실행문을 결과와 묶어 응답하는 Attach query가 하나 더 붙어 4노드다."""
    expected_node_counts = {W1_PATH: 3, W2_PATH: 4}
    for path in EXECUTORS:
        wf = _load(path)
        assert len(wf["nodes"]) == expected_node_counts[path], path.name
        trigger = next(n for n in wf["nodes"] if n["type"] == "n8n-nodes-base.webhook")
        # 결과가 곧 HTTP 응답 — 백엔드가 받아서 다음 쿼리를 정한다
        assert trigger["parameters"]["responseMode"] == "lastNode", path.name
        # n8n 기본값은 "첫 항목만" — 지정하지 않으면 결과가 1행으로 잘린다(실서버에서
        # 테이블 11개·컬럼 1개만 적재된 사고의 원인). 전 행 반환을 계약으로 고정한다.
        assert trigger["parameters"]["responseData"] == "allEntries", path.name
        mssql = next(n for n in wf["nodes"] if n["type"] == "n8n-nodes-base.microsoftSql")
        # SQL은 Code 노드 산출물만 — 외부 문자열을 직접 실행하지 않는다
        assert mssql["parameters"]["query"] == "={{ $json.query }}", path.name


def test_executors_need_no_env_or_secrets():
    """실서버 n8n은 env 주입이 불가하고 임포트 후 편집도 없어야 한다."""
    for path in EXECUTORS:
        text = path.read_text()
        assert "$env." not in text, path.name
        assert "INGEST" not in text and "API-KEY" not in text, path.name


def test_catalog_executor_covers_every_collect_query():
    """W1 계약 — kind별 고정 SQL이 파일과 일치하고, 정수 외 파라미터는 통과 못 한다."""
    wf = _load(W1_PATH)
    trigger = next(n for n in wf["nodes"] if n["type"] == "n8n-nodes-base.webhook")
    assert trigger["parameters"]["path"] == "dbv-catalog"
    js = next(n for n in wf["nodes"]
              if n["type"] == "n8n-nodes-base.code")["parameters"]["jsCode"]
    marker = "const TEMPLATES = "
    templates, _ = json.JSONDecoder().raw_decode(js, js.index(marker) + len(marker))
    for kind, filename in build_n8n_workflow.CATALOG_QUERY_KINDS:
        assert templates[kind] == (REPO_ROOT / "n8n" / "sql" / filename).read_text()
    assert "parseInt" in js and "Number.isInteger" in js  # 정수만 보간
    assert "unknown kind" in js                            # 그 외 kind 거부


def test_catalog_runner_kinds_match_the_workflow():
    """서비스가 부르는 kind와 워크플로 템플릿이 어긋나면 런타임에만 터진다 — 여기서 잡는다."""
    runner_src = (REPO_ROOT / "backend" / "app" / "adapters" / "collect_runner.py").read_text()
    called = set(re.findall(r'self\._query\("(\w+)"', runner_src))
    assert called <= {kind for kind, _ in build_n8n_workflow.CATALOG_QUERY_KINDS}
    # 파라미터 있는 kind는 모두 id 목록 또는 페이지 창을 쓴다 / every template is bounded
    for kind, filename in build_n8n_workflow.CATALOG_QUERY_KINDS:
        sql = (REPO_ROOT / "n8n" / "sql" / filename).read_text()
        if kind in {"columns", "key_constraints", "view_definitions", "view_deps", "view_refs"}:
            assert "{{ID_LIST}}" in sql, kind
        if kind == "objects":
            assert "{{OFFSET}}" in sql and "{{LIMIT}}" in sql


def test_query_executor_contract():
    """W2 계약 — 고정 템플릿 3종, 이스케이프, 동적 SQL 미수신."""
    wf = _load(W2_PATH)
    js = next(n for n in wf["nodes"]
              if n["type"] == "n8n-nodes-base.code")["parameters"]["jsCode"]
    for kind in ("containment", "join_preview", "table_preview"):
        assert kind in js
    assert "']]'" in js or "]]" in js      # 식별자 브래킷 이스케이프
    assert "''" in js                       # 리터럴 이스케이프
    assert "unknown kind" in js             # 그 외 kind 거부


def test_w2_builds_a_multi_join_preview_from_steps() -> None:
    """N-웨이 조인 — 첫 스텝의 left가 FROM, 이후 각 스텝이 JOIN 한 줄."""
    wf = _load(W2_PATH)
    js = next(n for n in wf["nodes"] if n["name"] == "Build query")["parameters"]["jsCode"]
    assert "multi_join_preview" in js
    # join_type은 화이트리스트 매핑 — 임의 문자열이 SQL에 들어가면 안 된다
    assert "INNER JOIN" in js and "LEFT JOIN" in js
    assert "b.join_type" not in js.replace("b.join_type === 'left'", "")


def test_w2_returns_the_executed_sql_with_the_rows() -> None:
    """실행문을 응답에 실어 보낸다 — 화면이 진짜 돌아간 SQL을 보여줄 수 있게."""
    wf = _load(W2_PATH)
    names = [n["name"] for n in wf["nodes"]]
    assert names == ["Webhook", "Build query", "Run query", "Attach query"]
    attach = next(n for n in wf["nodes"] if n["name"] == "Attach query")
    js = attach["parameters"]["jsCode"]
    assert "$('Build query')" in js
    assert "rows" in js and "query" in js


def test_recon_workflow_structure():
    """W0만 다중 노드 — 사람이 UI에서 1회 돌리는 진단이라 백엔드 경로가 없다."""
    wf = _load(RECON_PATH)
    names = {n["name"] for n in wf["nodes"]}
    for src, conn in wf["connections"].items():
        assert src in names
        for branch in conn["main"]:
            for target in branch:
                assert target["node"] in names
    by_name = {n["name"]: n for n in wf["nodes"]}
    for name, filename in build_n8n_workflow.RECON_SQL_NODES:
        assert by_name[name]["parameters"]["query"] == (
            REPO_ROOT / "n8n" / "sql" / filename
        ).read_text()
    report_js = by_name["Recon report"]["parameters"]["jsCode"]
    for name, _ in build_n8n_workflow.RECON_SQL_NODES:
        assert f"$('{name}')" in report_js


def test_code_nodes_reference_existing_nodes():
    for path in (RECON_PATH, *EXECUTORS):
        wf = _load(path)
        names = {n["name"] for n in wf["nodes"]}
        for node in wf["nodes"]:
            if node["type"] == "n8n-nodes-base.code":
                for ref in re.findall(r"\$\('([^']+)'\)", node["parameters"]["jsCode"]):
                    assert ref in names, f"{path.name}: unknown node ref {ref}"
