"""Phase 2 integration — column lineage and join extraction vs fixture truth. / Phase 2 픽스처 회귀."""

import sqlalchemy as sa

from app.models import Base


def _seed(client, load_fixture) -> tuple[int, dict]:
    sid = client.post("/api/ingest/catalog", json=load_fixture("catalog.json")).json()["snapshot_id"]
    res = client.post("/api/ingest/view-deps",
                      json={**load_fixture("view_deps.json"), "snapshot_id": sid})
    assert res.status_code == 200, res.text
    return sid, res.json()["counts"]


def _names(conn):
    obj_t = Base.metadata.tables["objects"]
    return {
        row.id: f"{row.schema}.{row.name}"
        for row in conn.execute(sa.select(obj_t.c.id, obj_t.c.schema, obj_t.c.name))
    }


def test_phase2_reports_parse_counts(client, load_fixture):
    _, counts = _seed(client, load_fixture)
    assert counts["views_parsed"] > 0
    assert counts.get("parse_ok", 0) > 0
    assert counts["column_lineage_rows"] > 0
    assert counts["view_joins"] > 0


def test_column_lineage_matches_fixture_truth(client, migrated_engine, load_fixture):
    """기대 direct/derived 행이 있는 뷰는 산출물이 정확히 일치해야 한다. / per-view equality."""
    _seed(client, load_fixture)

    expected_by_view: dict[str, set] = {}
    for r in load_fixture("expected/lineage_full.json")["rows"]:
        if r["mapping_kind"] in ("direct", "derived"):
            expected_by_view.setdefault(r["view"], set()).add(
                (r["view_column"], r["base"], r["base_column"], r["depth"], r["mapping_kind"])
            )

    with migrated_engine.connect() as conn:
        names = _names(conn)
        vlf = Base.metadata.tables["view_lineage_flat"]
        actual_by_view: dict[str, set] = {}
        for row in conn.execute(
            sa.select(vlf).where(vlf.c.mapping_kind.in_(["direct", "derived"]))
        ):
            actual_by_view.setdefault(names[row.view_object_id], set()).add(
                (row.view_column, names[row.base_object_id], row.base_column,
                 row.depth, row.mapping_kind)
            )

    for view, expected_rows in expected_by_view.items():
        assert actual_by_view.get(view) == expected_rows, f"lineage mismatch for {view}"


def test_view_joins_match_fixture_truth(client, migrated_engine, load_fixture):
    _seed(client, load_fixture)
    expected = {
        (j["view"], j["left_object"], j["left_column"],
         j["right_object"], j["right_column"], j["join_type"])
        for j in load_fixture("expected/joins.json")["rows"]
    }
    with migrated_engine.connect() as conn:
        names = _names(conn)
        col_t = Base.metadata.tables["columns"]
        col_info = {
            row.id: (names[row.object_id], row.name)
            for row in conn.execute(sa.select(col_t.c.id, col_t.c.object_id, col_t.c.name))
        }
        vj = Base.metadata.tables["view_joins"]
        actual = set()
        for row in conn.execute(sa.select(vj)):
            left_obj, left_col = col_info[row.left_column_id]
            right_obj, right_col = col_info[row.right_column_id]
            actual.add((names[row.view_object_id], left_obj, left_col,
                        right_obj, right_col, row.join_type))
    assert actual == expected


def test_parse_stats_endpoint(client, load_fixture):
    sid, _ = _seed(client, load_fixture)
    stats = client.get(f"/api/snapshots/{sid}/parse-stats").json()

    assert stats["counts"]["no_definition"] == 4  # V_SEC 권한 차단 뷰
    assert stats["counts"]["ok"] > 0
    assert stats["success_rate"] is not None and 0 < stats["success_rate"] <= 1
    # PIVOT 뷰는 격리 목록에 있어야 한다 / PIVOT views must be isolated
    failed_names = {f["name"] for f in stats["failed_views"]}
    assert any(n.startswith("dbo.V_PVT") for n in failed_names)
    total = sum(stats["counts"].values())
    assert total == stats["total_views"]


def test_catalog_set_rows_survive_phase2(client, migrated_engine, load_fixture):
    """파싱 결과는 보강만 — 카탈로그 set 행 개수는 그대로 (계획 §2.2). / augmentation only."""
    _seed(client, load_fixture)
    expected_set_rows = len(load_fixture("expected/lineage_phase1.json")["rows"])
    with migrated_engine.connect() as conn:
        vlf = Base.metadata.tables["view_lineage_flat"]
        actual_set_rows = conn.execute(
            sa.select(sa.func.count()).where(vlf.c.mapping_kind == "set")
        ).scalar()
    assert actual_set_rows == expected_set_rows
