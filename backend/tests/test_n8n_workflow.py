"""n8n 워크플로 JSON 정합성 테스트 / workflow JSON consistency tests.

핵심 계약: n8n은 **단문 쿼리 실행기**다 — 워크플로는 짧게 유지하고, 캐스케이드는
백엔드(N8nCollectRunner)가 주도한다. 정찰(W0)만 사람이 UI에서 한 번 돌리는 예외다.
"""

import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import build_n8n_workflow  # noqa: E402

RECON_PATH = REPO_ROOT / "n8n" / "workflows" / "w0_recon_queries.json"
W1_PATH = REPO_ROOT / "n8n" / "workflows" / "w1_catalog_query.json"
W2_PATH = REPO_ROOT / "n8n" / "workflows" / "w2_query_executor.json"
EXECUTORS = (W1_PATH, W2_PATH)

NODE_BIN = shutil.which("node")
# Build query 분기 로직은 값에 따라 갈리므로 문자열 검사로는 검증 불가 — 실제 실행이 유일한 수단.
# the join-chain branch taken depends on step data; only running the JS proves which branch fired.
_RETURN_MARKER = "return [{ json: { query } }];"


def _load(path: Path) -> dict:
    return json.loads(path.read_text())


def _run_build_query_js(js: str, body: dict) -> str:
    """W2의 Build query jsCode를 node로 그대로 실행해 실제 산출 SQL을 얻는다."""
    # 호출부(테스트 본문)가 NODE_BIN 부재 시 이미 fail()로 멈춘다 — 여기선 pyright의
    # str | None 경고만 없애는 타입 좁히기 목적. caller guarantees node is present;
    # this narrows the type for pyright, it does not change runtime behavior.
    assert NODE_BIN is not None
    assert _RETURN_MARKER in js, "Build query jsCode의 반환문 형태가 바뀌었다 — 테스트 갱신 필요"
    script = (
        "const $json = " + json.dumps({"body": body}, ensure_ascii=False) + ";\n"
        + js.replace(_RETURN_MARKER, "console.log(JSON.stringify({ query }));")
    )
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(script)
        path = f.name
    try:
        result = subprocess.run(
            [NODE_BIN, path], capture_output=True, text=True, timeout=10, check=True,
        )
    finally:
        Path(path).unlink(missing_ok=True)
    return json.loads(result.stdout)["query"]


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
    # n8n 기본값은 "첫 항목만"(firstEntryJson) — W1의 Run query는 행마다 아이템 하나씩
    # 내므로 지정하지 않으면 결과가 1행으로 잘린다(실서버에서 테이블 11개·컬럼 1개만
    # 적재된 사고의 원인) → allEntries로 override해 전 행을 배열로 받는다.
    # W2는 다르다 — 마지막 노드(Attach query)가 이미 모든 행을 단일 아이템
    # {query, rows}로 묶어 낸다. 여기에 allEntries를 쓰면 n8n이 "마지막 노드의
    # 아이템 배열"을 그대로 반환해 그 단일 아이템이 [{query, rows}]로 한 번 더
    # 감싸진다 — _post_query가 dict를 기대하는데 list가 와서 실패한다(Finding 1).
    # firstEntryJson(기본값과 동일 — 명시로 고정)이 정확히 {query, rows}를 돌려준다.
    # W1 returns one item per row, so it needs allEntries to avoid 1-row truncation.
    # W2's last node already bundles every row into one item; allEntries there would
    # wrap that single item in an array instead of returning it directly.
    expected_response_data = {W1_PATH: "allEntries", W2_PATH: "firstEntryJson"}
    for path in EXECUTORS:
        wf = _load(path)
        assert len(wf["nodes"]) == expected_node_counts[path], path.name
        trigger = next(n for n in wf["nodes"] if n["type"] == "n8n-nodes-base.webhook")
        # 결과가 곧 HTTP 응답 — 백엔드가 받아서 다음 쿼리를 정한다
        assert trigger["parameters"]["responseMode"] == "lastNode", path.name
        assert trigger["parameters"]["responseData"] == expected_response_data[path], path.name
        mssql = next(n for n in wf["nodes"] if n["type"] == "n8n-nodes-base.microsoftSql")
        # SQL은 Code 노드 산출물만 — 외부 문자열을 직접 실행하지 않는다
        assert mssql["parameters"]["query"] == "={{ $json.query }}", path.name


def test_w2_response_data_matches_attach_query_shape() -> None:
    """W2 전용 회귀 고정 — Attach query가 이미 단일 아이템으로 묶으므로 W1과 같은
    allEntries를 쓰면 그 아이템이 배열에 한 번 더 감싸여 {query, rows} 계약이
    깨진다(Finding 1: 재임포트 시 모든 kind가 500이 되는 원인). W1과 W2가 서로
    다른 responseData를 쓰는 이유를 한 곳에 못박는다.
    W2-only pin: allEntries would double-wrap Attach query's single bundled item and
    break the {query, rows} contract every kind depends on."""
    wf = _load(W2_PATH)
    trigger = next(n for n in wf["nodes"] if n["type"] == "n8n-nodes-base.webhook")
    assert trigger["parameters"]["responseData"] == "firstEntryJson"


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
    # join_type 문자열 비교는 한 곳(wantsLeft 산출)뿐 — 그 불리언 결과를 여러 분기가
    # 참조해 INNER/LEFT/RIGHT 중 하나를 고른다(방향은 어느 쪽이 새로 바인딩되는지에
    # 따라 갈린다 — Finding 2). 임의 문자열이 SQL에 직접 들어가지 않는다는 걸
    # "st.join_type" 등장 횟수로 고정한다(비교 외 경로로 새면 카운트가 늘어난다).
    # join_type is string-compared exactly once; every branch picks its JOIN keyword
    # from that boolean, not the raw string, so no arbitrary text can reach the SQL.
    assert "INNER JOIN" in js and "LEFT JOIN" in js and "RIGHT JOIN" in js
    assert "st.join_type === 'left'" in js
    assert js.count("st.join_type") == 1


def test_multi_join_preview_predicate_lands_on_the_owning_clause() -> None:
    """4테이블 체인(A-B, B-C, C-D LEFT, 닫는 스텝 A-C)에서 '양쪽 다 바인딩됨' 분기가
    가장 최근 clause(D의 LEFT JOIN)가 아니라 실제로 그 alias가 등장한 clause(C의
    INNER JOIN)에 AND를 붙이는지 검증한다. 최근 clause에 잘못 붙이면 D의 null-확장
    조건이 바뀔 뿐 A-C는 전혀 제약되지 않는데도 예외 없이 조용히 틀린 결과를 낸다 —
    실제 jsCode를 node로 실행해 산출 SQL을 확인해야만 잡히는 버그라 문자열 검사로는
    검증 불가능하다."""
    if NODE_BIN is None:
        # 이 조인-체인 분기 버그는 스텝 데이터에 따라 갈리는 제어 흐름 문제라 jsCode
        # 문자열 검사로는 검증할 수 없다 — 실행이 유일한 수단이므로 node 부재를 조용히
        # 건너뛰면 이 회귀 클래스의 유일한 커버리지가 CI 그린 뒤에서 사라진다.
        # skip silently here would let this bug class regress behind a green suite;
        # node is the only way to verify step-data-dependent join-chain placement.
        pytest.fail(
            "node runtime is required to execute the generated Build query JS — "
            "join-chain clause placement is control-flow-dependent on step data "
            "and cannot be verified by string inspection of jsCode alone"
        )
    wf = _load(W2_PATH)
    js = next(n for n in wf["nodes"] if n["name"] == "Build query")["parameters"]["jsCode"]
    steps = [
        {"left_schema": "s", "left_table": "A", "left_column": "a1",
         "right_schema": "s", "right_table": "B", "right_column": "b1", "join_type": "inner"},
        {"left_schema": "s", "left_table": "B", "left_column": "b2",
         "right_schema": "s", "right_table": "C", "right_column": "c1", "join_type": "inner"},
        {"left_schema": "s", "left_table": "C", "left_column": "c2",
         "right_schema": "s", "right_table": "D", "right_column": "d1", "join_type": "left"},
        # 닫는 스텝 — A(t0)와 C(t2) 모두 이미 바인딩됨. AND는 C가 등장한
        # clause(INNER JOIN C)에 붙어야 하며, 이후에 추가된 D의 LEFT JOIN에 붙으면 안 된다.
        {"left_schema": "s", "left_table": "A", "left_column": "a2",
         "right_schema": "s", "right_table": "C", "right_column": "c3", "join_type": "inner"},
    ]
    query = _run_build_query_js(js, {"kind": "multi_join_preview", "steps": steps})
    from_clause = query.split(" FROM ", 1)[1]
    expected_from = (
        "[s].[A] t0 INNER JOIN [s].[B] t1 ON t0.[a1] = t1.[b1] "
        "INNER JOIN [s].[C] t2 ON t1.[b2] = t2.[c1] AND t0.[a2] = t2.[c3] "
        "LEFT JOIN [s].[D] t3 ON t2.[c2] = t3.[d1]"
    )
    assert from_clause == expected_from, from_clause


def test_multi_join_preview_aliases_stay_distinct_across_schemas() -> None:
    """스키마가 다른 동명 테이블(예: ATM.PI_X / SAP.PI_X)을 조인하면 별칭이 충돌해
    JSON 행에서 한쪽 값이 다른 쪽을 덮어쓴다 — 마스킹 이전에 데이터 자체가 틀려지는
    문제라, 별칭에 스키마까지 포함해 구분되는지를 실제 실행으로 검증한다(문자열
    검사만으로는 별칭이 진짜 갈리는지 확인 불가)."""
    if NODE_BIN is None:
        pytest.fail(
            "node runtime is required to execute the generated Build query JS — "
            "alias collision is only observable in the actual query text"
        )
    wf = _load(W2_PATH)
    js = next(n for n in wf["nodes"] if n["name"] == "Build query")["parameters"]["jsCode"]
    steps = [{
        "left_schema": "ATM", "left_table": "PI_X", "left_column": "ID",
        "right_schema": "SAP", "right_table": "PI_X", "right_column": "ID",
        "join_type": "inner",
    }]
    query = _run_build_query_js(js, {"kind": "multi_join_preview", "steps": steps})
    select_clause = query.split(" FROM ", 1)[0]
    aliases = re.findall(r"AS \[([^\]]+)\]", select_clause)
    assert aliases == ["ATM.PI_X.ID", "SAP.PI_X.ID"]
    assert len(set(aliases)) == len(aliases)


def test_multi_join_preview_left_join_preserves_the_newly_bound_left_table() -> None:
    """Finding 2 — 새 테이블이 스텝의 left(=검증에서 orphan을 센 src)로 들어오고
    join_type=left인 경우. 기존 체인은 스텝의 right(tgt) 쪽에 이미 있다. 순진하게
    LEFT JOIN을 쓰면 SQL의 "왼쪽"(보존되는 쪽)이 기존 체인(tgt)이 되어, verdict가
    보존을 약속한 src(신규 테이블)가 오히려 널-확장되어 사라진다 — RIGHT JOIN으로
    뒤집어야 새로 들어온 src가 보존된다."""
    if NODE_BIN is None:
        pytest.fail(
            "node runtime is required to execute the generated Build query JS — "
            "join direction depends on which side of the step is newly bound and "
            "cannot be verified by string inspection of jsCode alone"
        )
    wf = _load(W2_PATH)
    js = next(n for n in wf["nodes"] if n["name"] == "Build query")["parameters"]["jsCode"]
    steps = [
        {"left_schema": "s", "left_table": "A", "left_column": "a1",
         "right_schema": "s", "right_table": "B", "right_column": "b1", "join_type": "inner"},
        # C가 새로 들어오는 쪽이자 스텝의 left(=검증된 src) — B(t1)는 이미 바인딩됨
        {"left_schema": "s", "left_table": "C", "left_column": "c1",
         "right_schema": "s", "right_table": "B", "right_column": "b2", "join_type": "left"},
    ]
    query = _run_build_query_js(js, {"kind": "multi_join_preview", "steps": steps})
    from_clause = query.split(" FROM ", 1)[1]
    expected_from = (
        "[s].[A] t0 INNER JOIN [s].[B] t1 ON t0.[a1] = t1.[b1] "
        "RIGHT JOIN [s].[C] t2 ON t2.[c1] = t1.[b2]"
    )
    assert from_clause == expected_from, from_clause


def test_multi_join_preview_left_join_preserves_the_newly_bound_right_table() -> None:
    """미러 케이스 — 새 테이블이 스텝의 right로 들어오면 기존 코드가 이미 정확하다
    (verdict의 src가 항상 기존 체인 쪽에 있으므로 평범한 LEFT JOIN이 그 src를 보존한다).
    Finding 2가 고친 왼쪽 케이스와 짝을 이루는 회귀 방지 고정."""
    if NODE_BIN is None:
        pytest.fail(
            "node runtime is required to execute the generated Build query JS — "
            "join direction depends on which side of the step is newly bound and "
            "cannot be verified by string inspection of jsCode alone"
        )
    wf = _load(W2_PATH)
    js = next(n for n in wf["nodes"] if n["name"] == "Build query")["parameters"]["jsCode"]
    steps = [{
        "left_schema": "s", "left_table": "A", "left_column": "a1",
        "right_schema": "s", "right_table": "B", "right_column": "b1", "join_type": "left",
    }]
    query = _run_build_query_js(js, {"kind": "multi_join_preview", "steps": steps})
    from_clause = query.split(" FROM ", 1)[1]
    assert from_clause == "[s].[A] t0 LEFT JOIN [s].[B] t1 ON t0.[a1] = t1.[b1]", from_clause


def test_multi_join_preview_rejects_left_join_between_already_bound_tables() -> None:
    """Finding 2 두 번째 증상 — 양쪽 다 이미 바인딩된 닫는 스텝은 새 JOIN이 아니라
    기존 clause에 AND로 붙는다. 그 지점엔 독립된 LEFT 방향이 없어 join_type=left를
    조용히 무시하는 대신 예외를 던진다 — 백엔드의 _check_connectivity가 같은 규칙을
    먼저 걸러내지만, 워크플로가 단독으로 재생되는 경로에도 방어선을 남긴다."""
    if NODE_BIN is None:
        pytest.fail(
            "node runtime is required to execute the generated Build query JS — "
            "this rejection is control-flow-dependent on step data"
        )
    wf = _load(W2_PATH)
    js = next(n for n in wf["nodes"] if n["name"] == "Build query")["parameters"]["jsCode"]
    steps = [
        {"left_schema": "s", "left_table": "A", "left_column": "a1",
         "right_schema": "s", "right_table": "B", "right_column": "b1", "join_type": "inner"},
        {"left_schema": "s", "left_table": "A", "left_column": "a2",
         "right_schema": "s", "right_table": "B", "right_column": "b2", "join_type": "left"},
    ]
    with pytest.raises(subprocess.CalledProcessError):
        _run_build_query_js(js, {"kind": "multi_join_preview", "steps": steps})


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
