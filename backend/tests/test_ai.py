"""AI endpoint tests — suggestions never become facts. / AI 엔드포인트 테스트 (계획 Phase 5)."""

import pytest
import sqlalchemy as sa

from app.adapters.ai import CandidatePair, ColumnMeta, FakeAiClient, TableMeta
from app.api.ai import select_ai_candidates
from app.domain import scoring
from app.models import Base


def _seed(client, load_fixture) -> None:
    sid = client.post("/api/ingest/catalog", json=load_fixture("catalog.json")).json()["snapshot_id"]
    client.post("/api/ingest/view-deps",
                json={**load_fixture("view_deps.json"), "snapshot_id": sid})


def _pair(src_object, src_column, tgt_object, tgt_column, signals):
    return CandidatePair(
        src_object=src_object, src_column=src_column, src_type="int",
        src_is_pk=False, src_row_count=100,
        tgt_object=tgt_object, tgt_column=tgt_column, tgt_type="int",
        tgt_is_pk=True, tgt_row_count=50,
        score=52, signals=signals,
    )


def test_fake_client_judges_by_name_affinity_and_view_join():
    pairs = [
        _pair("dbo.T_ORD", "EMPNO", "dbo.T_EMP", "EMP_NO", ["key", "naming"]),
        _pair("dbo.T_A", "X_ID", "dbo.T_B", "Y_ID", ["view_join"]),
        _pair("dbo.T_C", "AAA", "dbo.T_D", "BBB", ["key"]),
    ]
    accepted = FakeAiClient().judge_relations(pairs)
    keys = [(s.src_object, s.src_column, s.tgt_object, s.tgt_column) for s in accepted]
    assert ("dbo.T_ORD", "EMPNO", "dbo.T_EMP", "EMP_NO") in keys
    assert ("dbo.T_A", "X_ID", "dbo.T_B", "Y_ID") in keys
    assert ("dbo.T_C", "AAA", "dbo.T_D", "BBB") not in keys  # 신호 없는 페어는 기각


def _col(cid, qname, name, is_pk=False):
    return scoring.ScoringColumn(
        column_id=cid, object_qname=qname, object_type="table", name=name,
        data_type="int", max_length=4, is_pk=is_pk, is_computed=False,
        distinct_count=100,
    )


def test_select_ai_candidates_prefers_pk_direction_and_caps():
    cols = {
        1: _col(1, "dbo.T_EMP", "EMP_NO", is_pk=True),
        2: _col(2, "dbo.T_ORD", "EMPNO"),
        3: _col(3, "dbo.T_ORD", "ORD_NO", is_pk=True),
        4: _col(4, "dbo.T_SHP", "ORD_NO"),
    }
    ranked = select_ai_candidates(cols, view_pairs=set(), fk_pairs=set(),
                                  min_distinct=50, blacklist=set(), max_pairs=1,
                                  existing=set())
    assert len(ranked) == 1  # 상한 적용
    src, cand = ranked[0]
    # 정확 동명(40+key20=60) > 정규화 변형(32+20=52) — 방향은 PK 쪽이 타깃
    assert (src.object_qname, src.name) == ("dbo.T_SHP", "ORD_NO")
    assert (cand.target.object_qname, cand.target.name) == ("dbo.T_ORD", "ORD_NO")


def test_select_ai_candidates_includes_view_join_pairs():
    cols = {
        1: _col(1, "dbo.T_A", "HDR_KEY"),
        2: _col(2, "dbo.T_B", "REF_CODE"),
    }
    ranked = select_ai_candidates(cols, view_pairs={frozenset((1, 2))},
                                  fk_pairs=set(), min_distinct=50,
                                  blacklist=set(), max_pairs=10, existing=set())
    # 이름이 달라도 뷰 JOIN 증거만으로 후보가 된다
    assert len(ranked) == 1
    assert ranked[0][1].signals.get("view_join") == scoring.WEIGHT_VIEW_JOIN


def test_select_ai_candidates_dedupes_before_cap_so_reruns_page_onward():
    cols = {
        1: _col(1, "dbo.T_EMP", "EMP_NO", is_pk=True),
        2: _col(2, "dbo.T_ORD", "EMPNO"),
        3: _col(3, "dbo.T_ORD", "ORD_NO", is_pk=True),
        4: _col(4, "dbo.T_SHP", "ORD_NO"),
    }
    # 1위 페어(T_SHP.ORD_NO -> T_ORD.ORD_NO, 60점)가 이미 관계로 존재한다고 가정
    existing = {("dbo.T_SHP", "ORD_NO", "dbo.T_ORD", "ORD_NO")}
    ranked = select_ai_candidates(cols, view_pairs=set(), fk_pairs=set(),
                                  min_distinct=50, blacklist=set(), max_pairs=1,
                                  existing=existing)
    assert len(ranked) == 1
    src, cand = ranked[0]
    # 상한(1) 적용 전에 1위가 걸러져야 2위가 다음 실행에서 판정 대상이 된다
    assert (src.object_qname, src.name) == ("dbo.T_ORD", "EMPNO")
    assert (cand.target.object_qname, cand.target.name) == ("dbo.T_EMP", "EMP_NO")


def test_fake_client_search_ranks_by_term_overlap():
    tables = [
        TableMeta("dbo.T_SHP_RSLT", [ColumnMeta("SHIP_QTY", "int")]),
        TableMeta("dbo.T_HR_MST", [ColumnMeta("EMP_NO", "int")]),
    ]
    hits = FakeAiClient().search_tables("SHP RSLT", tables)
    assert hits and hits[0].qname == "dbo.T_SHP_RSLT"
    assert all(h.qname != "dbo.T_HR_MST" for h in hits)


def test_suggest_relations_creates_ai_candidates_only(client, migrated_engine, load_fixture):
    _seed(client, load_fixture)
    body = client.post("/api/ai/suggest-relations").json()
    assert body["created"] > 0

    with migrated_engine.connect() as conn:
        rel_t = Base.metadata.tables["relations"]
        rows = conn.execute(sa.select(rel_t)).all()
    ai_rows = [r for r in rows if r.origin == "ai"]
    assert len(ai_rows) == body["created"]
    # AI 출력은 절대 confirmed로 저장되지 않는다 (계획 §5.2)
    assert all(r.status == "candidate" for r in ai_rows)


def test_suggest_relations_pages_without_dupes_then_exhausts(client, migrated_engine, load_fixture):
    _seed(client, load_fixture)
    total_created = 0
    for _ in range(30):  # 597후보/40상한 ≈ 15회 — 여유 상한, 무한루프 가드
        body = client.post("/api/ai/suggest-relations").json()
        total_created += body["created"]
        if body["created"] == 0:
            break
    else:
        pytest.fail("paging never exhausted")
    assert total_created > 40  # 상한 너머로 페이징됐다 — 구 버그(1회용 상한) 회귀 가드
    # 소진 후 재실행도 0 — 멱등 종착
    assert client.post("/api/ai/suggest-relations").json()["created"] == 0
    # 전 구간 중복 적재 없음 (방향 키 기준)
    with migrated_engine.connect() as conn:
        rel_t = Base.metadata.tables["relations"]
        rows = conn.execute(sa.select(rel_t)).all()
    keys = [(r.src_object, r.src_column, r.tgt_object, r.tgt_column)
            for r in rows if r.origin == "ai"]
    assert len(keys) == len(set(keys))
    assert len(keys) == total_created


def test_ai_candidate_cannot_be_confirmed_without_validation(client, migrated_engine, load_fixture):
    _seed(client, load_fixture)
    created = client.post("/api/ai/suggest-relations").json()["items"]
    target = created[0]

    obj_t, col_t = Base.metadata.tables["objects"], Base.metadata.tables["columns"]

    def col_id(qname: str, col: str) -> int:
        schema, table = qname.split(".", 1)
        with migrated_engine.connect() as conn:
            return conn.execute(
                sa.select(col_t.c.id)
                .join(obj_t, col_t.c.object_id == obj_t.c.id)
                .where(obj_t.c.schema == schema, obj_t.c.name == table,
                       col_t.c.name == col)
            ).scalar_one()

    res = client.post("/api/relations/confirm", json={
        "src_column_id": col_id(target["src_object"], target["src_column"]),
        "tgt_column_id": col_id(target["tgt_object"], target["tgt_column"]),
    })
    assert res.status_code == 400
    assert "validation" in res.json()["error"]["message"]


def test_ai_candidates_render_as_ai_suggested_edges(client, load_fixture):
    _seed(client, load_fixture)
    created = client.post("/api/ai/suggest-relations").json()["items"]
    target = created[0]
    _, table = target["src_object"].split(".", 1)
    items = client.get("/api/objects", params={"q": table}).json()["items"]
    anchor = next(i for i in items if f"{i['schema']}.{i['name']}" == target["src_object"])
    graph = client.get(f"/api/objects/{anchor['id']}/graph").json()
    assert any(e["kind"] == "ai_suggested" for e in graph["edges"])


def test_search_tables_endpoint(client, load_fixture):
    _seed(client, load_fixture)
    body = client.get("/api/ai/search-tables", params={"q": "ZZQX_NOPE"}).json()
    assert body["items"] == []  # 매칭 없음 — 빈 결과 상태

    manifest = load_fixture("manifest.json")
    trap = manifest["cases"]["low_cardinality"][0]
    table_name = trap.rsplit(".", 1)[0].split(".", 1)[1]
    body = client.get("/api/ai/search-tables", params={"q": table_name}).json()
    assert body["items"] and body["items"][0]["object"].endswith(table_name)
    assert body["items"][0]["object_id"] is not None


def test_summarize_caches_and_feeds_graph_tooltip(client, load_fixture):
    _seed(client, load_fixture)
    rel = load_fixture("expected/relations.json")["rows"][0]
    _, table = rel["src_object"].split(".", 1)
    items = client.get("/api/objects", params={"q": table}).json()["items"]
    anchor = next(i for i in items if f"{i['schema']}.{i['name']}" == rel["src_object"])

    first = client.post(f"/api/ai/summarize/{anchor['id']}").json()
    assert first["cached"] is False and rel["src_object"] in first["summary"]
    second = client.post(f"/api/ai/summarize/{anchor['id']}").json()
    assert second["cached"] is True and second["summary"] == first["summary"]

    graph = client.get(f"/api/objects/{anchor['id']}/graph").json()
    me = next(n for n in graph["nodes"] if n["id"] == anchor["id"])
    assert me["ai_summary"] == first["summary"]



def test_explain_view_narrates_lineage_and_columns(client, load_fixture):
    _seed(client, load_fixture)
    view = client.get("/api/objects?q=V_&type=view&limit=1").json()["items"][0]
    body = client.post(f"/api/ai/explain-view/{view['id']}").json()
    assert body["object"] == f"{view['schema']}.{view['name']}"
    assert "컬럼" in body["explanation"]

    # 테이블에는 거부 / rejected for tables
    table_id = client.get("/api/objects?q=HR_EMP&type=table&limit=1").json()["items"][0]["id"]
    assert client.post(f"/api/ai/explain-view/{table_id}").status_code == 404


def test_explain_validation_requires_history_then_narrates(
    client, migrated_engine, fixture_dir, load_fixture,
):
    from app.adapters.fake_validator import FakeJoinValidator
    from app.api.validate import get_join_validator

    _seed(client, load_fixture)
    rel = next(
        r for r in load_fixture("expected/relations.json")["rows"]
        if r["kind"] == "real_no_fk" and r["orphan_count"] == 0
    )
    col_t, obj_t = Base.metadata.tables["columns"], Base.metadata.tables["objects"]

    def column_id(qname: str, column: str) -> int:
        schema, name = qname.split(".", 1)
        with migrated_engine.connect() as conn:
            return conn.execute(
                sa.select(col_t.c.id)
                .join(obj_t, col_t.c.object_id == obj_t.c.id)
                .where(obj_t.c.schema == schema, obj_t.c.name == name,
                       col_t.c.name == column)
            ).scalar_one()

    src_id = column_id(rel["src_object"], rel["src_column"])
    tgt_id = column_id(rel["tgt_object"], rel["tgt_column"])
    params = f"src_column_id={src_id}&tgt_column_id={tgt_id}"

    # 이력 없음 → 404 / no history yet
    assert client.post(f"/api/ai/explain-validation?{params}").status_code == 404

    # T2 관측 1회 후 진단 문장 생성 / narrates after one observation
    client.app.dependency_overrides[get_join_validator] = lambda: FakeJoinValidator(
        fixture_dir / "value_sets.json"
    )
    client.post("/api/validate/containment", json={
        "src_column_id": src_id, "tgt_column_id": tgt_id,
    })
    body = client.post(f"/api/ai/explain-validation?{params}").json()
    assert "100.0%" in body["explanation"]
    assert "우연" in body["explanation"]  # 관측 1회 → small_sample_only 진단
