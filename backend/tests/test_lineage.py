"""Lineage engine tests — unit cases plus full-fixture regression. / lineage 엔진 단위 + 픽스처 회귀 테스트."""

import sqlalchemy as sa

from app.domain.lineage import resolve_lineage
from app.models import Base

# 단위 테스트용 id 약속: 1xx=table, 2xx=view / unit-test id convention


def test_direct_table_deps_resolve_at_depth_1():
    rows = resolve_lineage({201: [(101, False, "A"), (101, False, "B")]})
    assert [(r["base_object_id"], r["base_column"], r["depth"], r["flag"]) for r in rows] == [
        (101, "A", 1, None), (101, "B", 1, None),
    ]


def test_nested_view_inherits_full_parent_set():
    deps = {
        201: [(101, False, "A"), (102, False, "X")],
        202: [(201, True, "A")],  # 참조 컬럼과 무관하게 부모 전체 집합 상속
    }
    rows = [r for r in resolve_lineage(deps) if r["view_object_id"] == 202]
    assert {(r["base_object_id"], r["base_column"], r["depth"]) for r in rows} == {
        (101, "A", 2), (102, "X", 2),
    }


def test_cycle_is_flagged_not_infinite():
    deps = {201: [(202, True, "V")], 202: [(201, True, "V")]}
    rows = resolve_lineage(deps)
    assert len(rows) == 2
    assert all(r["flag"] == "cycle" and r["depth"] == 0 and r["base_object_id"] is None
               for r in rows)


def test_cycle_flag_propagates_to_downstream_views():
    deps = {
        201: [(202, True, "V")], 202: [(201, True, "V")],
        203: [(201, True, "V")],  # 순환 밖에서 순환 뷰를 참조 / references the cycle from outside
    }
    rows = [r for r in resolve_lineage(deps) if r["view_object_id"] == 203]
    assert [(r["flag"], r["base_object_id"]) for r in rows] == [("cycle", None)]


def test_depth_limit_flags_and_stops():
    # 1(table) ← 201 ← 202 ← 203 체인, limit 2 → 203은 depth_exceeded
    deps = {
        201: [(101, False, "A")],
        202: [(201, True, "A")],
        203: [(202, True, "A")],
    }
    rows = resolve_lineage(deps, depth_limit=2)
    by_view = {}
    for r in rows:
        by_view.setdefault(r["view_object_id"], []).append(r)
    assert by_view[202][0]["depth"] == 2 and by_view[202][0]["flag"] is None
    assert [(r["flag"], r["depth"]) for r in by_view[203]] == [("depth_exceeded", 2)]


def test_mixed_flag_keeps_resolved_rows():
    # 테이블 직접 참조 + 순환 뷰 참조 혼합 — 해석된 행 유지 + 플래그 행 추가
    deps = {
        201: [(202, True, "V")], 202: [(201, True, "V")],
        203: [(101, False, "A"), (201, True, "V")],
    }
    rows = [r for r in resolve_lineage(deps) if r["view_object_id"] == 203]
    assert {(r["base_object_id"], r["flag"]) for r in rows} == {(101, None), (None, "cycle")}


def test_dmv_failed_views_resolve_with_null_columns():
    rows = resolve_lineage({201: [(101, False, None)]})
    assert [(r["base_object_id"], r["base_column"]) for r in rows] == [(101, None)]


def test_full_fixture_matches_expected_phase1(client, migrated_engine, load_fixture):
    """엔진 산출물 == 픽스처 기대치 (전체 집합 동일성) / full-set equality against expectations."""
    sid = client.post("/api/ingest/catalog", json=load_fixture("catalog.json")).json()["snapshot_id"]
    res = client.post(
        "/api/ingest/view-deps",
        json={**load_fixture("view_deps.json"), "snapshot_id": sid},
    )
    assert res.status_code == 200, res.text
    assert res.json()["counts"]["lineage_rows"] > 0

    with migrated_engine.connect() as conn:
        obj_t = Base.metadata.tables["objects"]
        names = {
            row.id: f"{row.schema}.{row.name}"
            for row in conn.execute(sa.select(obj_t.c.id, obj_t.c.schema, obj_t.c.name))
        }
        vlf = Base.metadata.tables["view_lineage_flat"]
        # Phase 2가 direct/derived 행을 보강하므로 set 행만 비교 / phase-1 rows only
        actual = {
            (names[r.view_object_id],
             names[r.base_object_id] if r.base_object_id else None,
             r.base_column, r.depth, r.flag)
            for r in conn.execute(sa.select(vlf).where(vlf.c.mapping_kind == "set"))
        }

    expected = {
        (r["view"], r["base"], r["base_column"], r["depth"], r["flag"])
        for r in load_fixture("expected/lineage_phase1.json")["rows"]
    }
    assert actual == expected
