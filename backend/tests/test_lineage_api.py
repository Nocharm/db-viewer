"""Lineage diagram payloads — 뷰 소스 흐름·컬럼 계보·영향도 팬아웃. / lineage graph endpoints."""

import sqlalchemy as sa

from app.config import get_settings
from app.models import Base


def _seed(client, load_fixture) -> int:
    sid = client.post("/api/ingest/catalog", json=load_fixture("catalog.json")).json()["snapshot_id"]
    res = client.post("/api/ingest/view-deps",
                      json={**load_fixture("view_deps.json"), "snapshot_id": sid})
    assert res.status_code == 200, res.text
    return sid


def _find_view_with_joins(engine) -> int:
    """JOIN이 추출된 뷰 — 소스 흐름 탭이 실제로 그릴 게 있는 케이스."""
    joins = Base.metadata.tables["view_joins"]
    with engine.connect() as conn:
        return conn.execute(
            sa.select(joins.c.view_object_id).limit(1)).scalar_one()


def _find_table_with_consumers(engine) -> int:
    """뷰가 읽고 있는 테이블 — 영향도가 비지 않는 케이스."""
    deps = Base.metadata.tables["view_deps"]
    objects = Base.metadata.tables["objects"]
    with engine.connect() as conn:
        return conn.execute(
            sa.select(deps.c.referenced_object_id)
            .join(objects, objects.c.id == deps.c.referenced_object_id)
            .where(deps.c.is_resolved.is_(True), objects.c.type == "table")
            .limit(1)
        ).scalar_one()


def test_view_diagram_carries_sources_joins_and_columns(client, load_fixture, migrated_engine):
    _seed(client, load_fixture)
    view_id = _find_view_with_joins(migrated_engine)

    body = client.get(f"/api/lineage/views/{view_id}").json()

    assert body["view"]["id"] == view_id and body["view"]["type"] == "view"
    assert body["view"]["definition"], "정의 SQL이 탭3의 입력이다"
    assert body["view"]["column_count"] > 0
    assert len(body["nodes"]) > 0, "직접 소스가 최소 하나는 있어야 JOIN이 나온다"
    assert len(body["joins"]) > 0
    join = body["joins"][0]
    assert "." in join["left_object"] and "." in join["right_object"]
    assert join["left_column"] and join["right_column"] and join["join_type"]
    # 컬럼 계보는 출력 컬럼 단위로 접혀 있고 각 소스는 qname.column 쌍이다
    for column in body["columns"]:
        assert column["kind"] in ("direct", "derived", "set")
        for source in column["sources"]:
            assert "." in source["object"] and source["depth"] >= 1


def test_view_diagram_nodes_expose_popover_fields(client, load_fixture, migrated_engine):
    """노드 팝오버가 쓰는 필드 — 없으면 호버 카드가 빈다."""
    _seed(client, load_fixture)
    view_id = _find_view_with_joins(migrated_engine)

    nodes = client.get(f"/api/lineage/views/{view_id}").json()["nodes"]

    resolved = [n for n in nodes if n["id"] is not None]
    assert resolved, "픽스처 뷰는 카탈로그 안 소스를 가진다"
    for node in resolved:
        assert node["column_count"] is not None and node["column_count"] >= 0
        assert node["type"] in ("table", "view")
        assert set(node) >= {"qname", "depth", "row_count", "ai_summary", "hidden", "columns"}
    assert any(node["direct"] for node in resolved), "FROM 절에 직접 쓰인 소스가 있어야 한다"


def test_view_diagram_rejects_tables_and_hidden_schemas(
    client, load_fixture, migrated_engine, monkeypatch,
):
    _seed(client, load_fixture)
    objects = Base.metadata.tables["objects"]
    with migrated_engine.connect() as conn:
        table_id = conn.execute(
            sa.select(objects.c.id).where(objects.c.type == "table").limit(1)).scalar_one()
    assert client.get(f"/api/lineage/views/{table_id}").status_code == 404
    assert client.get("/api/lineage/views/999999").status_code == 404

    view_id = _find_view_with_joins(migrated_engine)
    monkeypatch.setattr(get_settings(), "hidden_schemas", "dbo")
    res = client.get(f"/api/lineage/views/{view_id}")
    assert res.status_code == 403
    assert res.json()["error"]["context"]["schema"] == "dbo"


def test_impact_walks_consumers_outward_by_depth(client, load_fixture, migrated_engine):
    _seed(client, load_fixture)
    table_id = _find_table_with_consumers(migrated_engine)

    body = client.get(f"/api/lineage/objects/{table_id}/impact").json()

    assert body["root"]["id"] == table_id
    depths = {node["id"]: node["depth"] for node in body["nodes"]}
    assert depths[table_id] == 0, "루트는 depth 0"
    consumers = [n for n in body["nodes"] if n["depth"] >= 1]
    assert consumers, "이 테이블을 읽는 뷰가 최소 하나"
    assert all(n["type"] == "view" for n in consumers), "소비자는 뷰만 될 수 있다"
    # 간선은 양 끝이 모두 노드 목록에 있어야 그려진다 (끊긴 간선 금지)
    qnames = {n["qname"] for n in body["nodes"]}
    for edge in body["edges"]:
        assert edge["from"] in qnames and edge["to"] in qnames
        assert depths[edge["to_id"]] == depths[edge["from_id"]] + 1


def test_impact_depth_cap_shrinks_the_graph(client, load_fixture, migrated_engine):
    """max_depth는 상한이지 힌트가 아니다 — 넘는 노드가 응답에 남으면 화면이 과장된다."""
    _seed(client, load_fixture)
    table_id = _find_table_with_consumers(migrated_engine)

    shallow = client.get(f"/api/lineage/objects/{table_id}/impact?max_depth=1").json()

    assert max(node["depth"] for node in shallow["nodes"]) <= 1
    assert client.get(f"/api/lineage/objects/{table_id}/impact?max_depth=9").status_code == 422


def test_hidden_schema_columns_never_leak_through_a_visible_view(
    client, load_fixture, migrated_engine, monkeypatch,
):
    """감춘 스키마의 테이블을 읽는 뷰의 다이어그램 — 이름은 남고 컬럼은 빠져야 한다.

    숨김 정책은 "이름은 목록에 남되 컬럼과 파생물은 전부 뺀다"이다(`schema_visibility`).
    다이어그램은 소스 노드의 컬럼과 컬럼 계보를 싣고 나가므로 같은 기준이 걸려야 한다.
    """
    _seed(client, load_fixture)
    view_id = _find_view_with_joins(migrated_engine)
    objects = Base.metadata.tables["objects"]

    # 뷰 자신은 보이게, 소스 테이블만 감춘 스키마로 옮긴다
    with migrated_engine.begin() as conn:
        source_id = conn.execute(sa.text(
            "SELECT referenced_object_id FROM view_deps "
            "WHERE view_object_id = :v AND is_resolved = 1 LIMIT 1"
        ), {"v": view_id}).scalar_one()
        conn.execute(objects.update().where(objects.c.id == source_id)
                     .values(schema="secret"))
    monkeypatch.setattr(get_settings(), "hidden_schemas", "secret")

    body = client.get(f"/api/lineage/views/{view_id}").json()

    hidden_nodes = [n for n in body["nodes"] if n["qname"].startswith("secret.")]
    assert hidden_nodes, "감춘 스키마도 이름은 그래프에 남는다"
    for node in hidden_nodes:
        assert node["hidden"] is True
        assert node["columns"] == [], "감춘 스키마의 컬럼명이 노드에 실리면 안 된다"
    for column in body["columns"]:
        leaked = [s for s in column["sources"]
                  if s["object"].startswith("secret.") and s["column"] is not None]
        assert not leaked, f"컬럼 계보로 새어 나감: {leaked}"
