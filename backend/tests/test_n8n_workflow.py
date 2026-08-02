"""W1 workflow JSON consistency tests. / n8n W1 워크플로 정합성 테스트."""

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import build_n8n_workflow  # noqa: E402

WORKFLOW_PATH = REPO_ROOT / "n8n" / "workflows" / "w1_catalog_snapshot.json"
RECON_PATH = REPO_ROOT / "n8n" / "workflows" / "w0_recon_queries.json"
W1A_PATH = REPO_ROOT / "n8n" / "workflows" / "w1a_collect_catalog.json"
W1B_PATH = REPO_ROOT / "n8n" / "workflows" / "w1b_collect_viewdeps.json"
W2_PATH = REPO_ROOT / "n8n" / "workflows" / "w2_query_executor.json"


def test_committed_workflow_matches_regeneration():
    # SQL 파일이 단일 소스 — 커밋본과 재생성본이 다르면 드리프트 / drift guard
    committed = json.loads(WORKFLOW_PATH.read_text())
    assert committed == build_n8n_workflow.build_workflow()


def test_committed_recon_workflow_matches_regeneration():
    committed = json.loads(RECON_PATH.read_text())
    assert committed == build_n8n_workflow.build_recon_workflow()


def test_committed_collect_workflows_match_regeneration():
    assert json.loads(W1A_PATH.read_text()) == build_n8n_workflow.build_collect_catalog_workflow()
    assert json.loads(W1B_PATH.read_text()) == build_n8n_workflow.build_collect_viewdeps_workflow()


def test_collect_workflows_echo_job_id_and_split_sql():
    """단계 워크플로 계약 — webhook 트리거, collect_job_id 반향, SQL 분할이 W1 전체를 덮는다."""
    w1a = json.loads(W1A_PATH.read_text())
    w1b = json.loads(W1B_PATH.read_text())
    for wf in (w1a, w1b):
        trigger = next(n for n in wf["nodes"] if n["type"] == "n8n-nodes-base.webhook")
        assert trigger["parameters"]["httpMethod"] == "POST"
        code = next(n for n in wf["nodes"] if n["type"] == "n8n-nodes-base.code")
        assert "collect_job_id" in code["parameters"]["jsCode"]
        for ref in re.findall(r"\$\('([^']+)'\)", code["parameters"]["jsCode"]):
            assert ref in {n["name"] for n in wf["nodes"]}
    # 분할 SQL 합집합 == W1 전체 / the two steps cover exactly the W1 query set
    split = [n for n, _ in build_n8n_workflow.CATALOG_SQL_NODES] + [
        n for n, _ in build_n8n_workflow.VIEW_DEPS_SQL_NODES
    ]
    assert split == [n for n, _ in build_n8n_workflow.SQL_NODES]
    # 2단계는 snapshot_id를 webhook body에서 받는다 / step 2 reads snapshot_id from the trigger
    w1b_code = next(n for n in w1b["nodes"] if n["type"] == "n8n-nodes-base.code")
    assert "trigger.snapshot_id" in w1b_code["parameters"]["jsCode"]


def test_committed_query_executor_matches_regeneration():
    assert json.loads(W2_PATH.read_text()) == build_n8n_workflow.build_query_executor_workflow()


def test_query_executor_contract():
    """W2 계약 — 동기 응답, 고정 템플릿 3종, 이스케이프, 동적 SQL 미수신."""
    wf = json.loads(W2_PATH.read_text())
    trigger = next(n for n in wf["nodes"] if n["type"] == "n8n-nodes-base.webhook")
    assert trigger["parameters"]["responseMode"] == "lastNode"  # 쿼리 결과가 곧 응답
    code = next(n for n in wf["nodes"] if n["type"] == "n8n-nodes-base.code")
    js = code["parameters"]["jsCode"]
    for kind in ("containment", "join_preview", "table_preview"):
        assert kind in js
    assert "']]'" in js or "]]" in js      # 식별자 브래킷 이스케이프
    assert "''" in js                       # 리터럴 이스케이프
    assert "unknown kind" in js             # 그 외 kind 거부
    mssql = next(n for n in wf["nodes"] if n["type"] == "n8n-nodes-base.microsoftSql")
    # SQL은 Code 노드 산출물만 — 외부에서 온 문자열을 직접 실행하지 않는다
    assert mssql["parameters"]["query"] == "={{ $json.query }}"


def test_recon_workflow_structure():
    wf = json.loads(RECON_PATH.read_text())
    names = {n["name"] for n in wf["nodes"]}
    for src, conn in wf["connections"].items():
        assert src in names
        for branch in conn["main"]:
            for target in branch:
                assert target["node"] in names
    # 6종 쿼리가 파일과 일치 / all six recon queries embed their files
    by_name = {n["name"]: n for n in wf["nodes"]}
    for name, filename in build_n8n_workflow.RECON_SQL_NODES:
        assert by_name[name]["parameters"]["query"] == (
            REPO_ROOT / "n8n" / "sql" / filename
        ).read_text()
    # 리포트 노드가 6개 노드를 모두 참조 / report references every query node
    report_js = by_name["Recon report"]["parameters"]["jsCode"]
    for name, _ in build_n8n_workflow.RECON_SQL_NODES:
        assert f"$('{name}')" in report_js


def test_connections_reference_existing_nodes():
    wf = json.loads(WORKFLOW_PATH.read_text())
    names = {n["name"] for n in wf["nodes"]}
    for src, conn in wf["connections"].items():
        assert src in names
        for branch in conn["main"]:
            for target in branch:
                assert target["node"] in names


def test_code_nodes_reference_existing_nodes():
    wf = json.loads(WORKFLOW_PATH.read_text())
    names = {n["name"] for n in wf["nodes"]}
    for node in wf["nodes"]:
        if node["type"] == "n8n-nodes-base.code":
            for ref in re.findall(r"\$\('([^']+)'\)", node["parameters"]["jsCode"]):
                assert ref in names, f"code node references unknown node: {ref}"


def test_sql_nodes_embed_current_sql_files():
    wf = json.loads(WORKFLOW_PATH.read_text())
    by_name = {n["name"]: n for n in wf["nodes"]}
    for name, filename in build_n8n_workflow.SQL_NODES:
        embedded = by_name[name]["parameters"]["query"]
        assert embedded == (REPO_ROOT / "n8n" / "sql" / filename).read_text()


def test_http_nodes_target_ingest_contract():
    wf = json.loads(WORKFLOW_PATH.read_text())
    urls = [n["parameters"]["url"] for n in wf["nodes"]
            if n["type"] == "n8n-nodes-base.httpRequest"]
    assert any(u.endswith("/api/ingest/catalog") for u in urls)
    assert any(u.endswith("/api/ingest/view-deps") for u in urls)
