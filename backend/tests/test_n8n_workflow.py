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


def test_committed_workflow_matches_regeneration():
    # SQL 파일이 단일 소스 — 커밋본과 재생성본이 다르면 드리프트 / drift guard
    committed = json.loads(WORKFLOW_PATH.read_text())
    assert committed == build_n8n_workflow.build_workflow()


def test_committed_recon_workflow_matches_regeneration():
    committed = json.loads(RECON_PATH.read_text())
    assert committed == build_n8n_workflow.build_recon_workflow()


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
