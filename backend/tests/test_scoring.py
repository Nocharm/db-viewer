"""Candidate scoring tests — unit plus fixture integration. / 후보 스코어링 테스트."""

import sqlalchemy as sa

from app.domain.scoring import (
    WEIGHT_KEY,
    WEIGHT_NAMING_EXACT,
    WEIGHT_NAMING_NORMALIZED,
    WEIGHT_VIEW_JOIN,
    ScoringColumn,
    check_exclusion,
    score_candidates,
)
from app.models import Base

BLACKLIST = {"USE_YN", "STATUS_CD"}


def make_col(cid: int, obj: str, name: str, *, data_type="int", max_length=4,
             is_pk=False, is_computed=False, distinct=None,
             object_type="table") -> ScoringColumn:
    return ScoringColumn(cid, obj, object_type, name, data_type, max_length,
                         is_pk, is_computed, distinct)


def test_exclusion_reasons():
    assert check_exclusion(make_col(1, "dbo.T", "USE_YN"), 50, BLACKLIST) == "blacklist"
    assert check_exclusion(make_col(1, "dbo.T", "C", distinct=3), 50, BLACKLIST) == "low_distinct"
    assert check_exclusion(make_col(1, "dbo.T", "C", is_computed=True), 50, BLACKLIST) == "computed"
    assert check_exclusion(make_col(1, "dbo.V", "C", object_type="view"), 50, BLACKLIST) == "not_a_table"
    assert check_exclusion(make_col(1, "dbo.T", "EMP_NO", distinct=500), 50, BLACKLIST) is None


def test_scoring_weights_and_ranking():
    src = make_col(1, "dbo.CHILD", "EMP_NO")
    exact_pk = make_col(2, "dbo.EMP", "EMP_NO", is_pk=True)
    variant = make_col(3, "dbo.EMP2", "EMPNO")
    joined = make_col(4, "dbo.EMP3", "OTHER_NO", is_pk=True)
    unrelated = make_col(5, "dbo.X", "AMT")

    result = score_candidates(
        src, [exact_pk, variant, joined, unrelated],
        view_join_pairs={frozenset((1, 4))}, existing_fk_pairs=set(),
        min_distinct=50, blacklist=BLACKLIST,
    )
    scores = {c.target.column_id: (c.score, c.signals) for c in result}
    assert scores[2] == (WEIGHT_NAMING_EXACT + WEIGHT_KEY,
                         {"naming": WEIGHT_NAMING_EXACT, "key": WEIGHT_KEY})
    assert scores[3] == (WEIGHT_NAMING_NORMALIZED, {"naming": WEIGHT_NAMING_NORMALIZED})
    assert scores[4] == (WEIGHT_VIEW_JOIN + WEIGHT_KEY,
                         {"view_join": WEIGHT_VIEW_JOIN, "key": WEIGHT_KEY})
    assert 5 not in scores  # 신호 없음 — 키 단독도 아님 / no signal at all
    assert result[0].target.column_id == 4  # view_join이 최상 / top weight wins


def test_key_bonus_never_stands_alone():
    src = make_col(1, "dbo.CHILD", "EMP_NO")
    pk_only = make_col(2, "dbo.OTHER", "XYZ_ID", is_pk=True)
    result = score_candidates(src, [pk_only], set(), set(), 50, BLACKLIST)
    assert result == []


def test_existing_fk_pairs_are_skipped():
    src = make_col(1, "dbo.CHILD", "EMP_NO")
    parent = make_col(2, "dbo.EMP", "EMP_NO", is_pk=True)
    result = score_candidates(src, [parent], set(), {frozenset((1, 2))}, 50, BLACKLIST)
    assert result == []


def test_type_incompatible_targets_are_filtered():
    src = make_col(1, "dbo.CHILD", "EMP_NO", data_type="varchar", max_length=20)
    shorter = make_col(2, "dbo.EMP", "EMP_NO", data_type="varchar", max_length=10)
    intcol = make_col(3, "dbo.EMP2", "EMP_NO", data_type="int", max_length=4)
    result = score_candidates(src, [shorter, intcol], set(), set(), 50, BLACKLIST)
    assert result == []


def _seed(client, load_fixture) -> None:
    sid = client.post("/api/ingest/catalog", json=load_fixture("catalog.json")).json()["snapshot_id"]
    client.post("/api/ingest/view-deps",
                json={**load_fixture("view_deps.json"), "snapshot_id": sid})


def _column_id(engine, object_qname: str, column: str) -> int:
    schema, table = object_qname.split(".", 1)
    obj_t, col_t = Base.metadata.tables["objects"], Base.metadata.tables["columns"]
    with engine.connect() as conn:
        return conn.execute(
            sa.select(col_t.c.id)
            .join(obj_t, col_t.c.object_id == obj_t.c.id)
            .where(obj_t.c.schema == schema, obj_t.c.name == table, col_t.c.name == column)
        ).scalar_one()


def test_candidates_surface_expected_relation(client, migrated_engine, load_fixture):
    """뷰 JOIN에 등장한 real_no_fk 관계는 최상위 후보로 떠야 한다. / top candidate check."""
    _seed(client, load_fixture)
    rel = next(r for r in load_fixture("expected/relations.json")["rows"]
               if r["kind"] == "real_no_fk" and r["in_view_join"])
    src_id = _column_id(migrated_engine, rel["src_object"], rel["src_column"])

    body = client.get(f"/api/columns/{src_id}/candidates").json()
    assert body["excluded"] is None
    top = body["candidates"][0]
    assert (top["object"], top["column"]) == (rel["tgt_object"], rel["tgt_column"])
    assert top["signals"].get("view_join") == WEIGHT_VIEW_JOIN


def test_fk_relation_is_not_suggested_again(client, migrated_engine, load_fixture):
    _seed(client, load_fixture)
    rel = next(r for r in load_fixture("expected/relations.json")["rows"]
               if r["kind"] == "fk")
    src_id = _column_id(migrated_engine, rel["src_object"], rel["src_column"])
    body = client.get(f"/api/columns/{src_id}/candidates").json()
    pairs = {(c["object"], c["column"]) for c in body["candidates"]}
    assert (rel["tgt_object"], rel["tgt_column"]) not in pairs


def test_trap_column_is_excluded_with_reason(client, migrated_engine, load_fixture):
    _seed(client, load_fixture)
    trap = load_fixture("manifest.json")["cases"]["low_cardinality"][0]
    obj, col = trap.rsplit(".", 1)
    src_id = _column_id(migrated_engine, obj, col)
    body = client.get(f"/api/columns/{src_id}/candidates").json()
    assert body["excluded"]["reason"] in ("blacklist", "low_distinct")
    assert body["candidates"] == []


def test_type_family_groups_int_and_char_variants():
    from app.domain.scoring import get_type_family

    assert get_type_family("int") == get_type_family("bigint") == "int"
    assert get_type_family("varchar") == get_type_family("nchar") == "char"
    # 패밀리 밖은 타입명 그대로 — 같은 타입끼리만 같은 패밀리
    assert get_type_family("datetime2") == "datetime2"
    assert get_type_family("int") != get_type_family("varchar")
