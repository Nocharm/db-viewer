"""Table-browser endpoints — join keys, detail, preview. / 브라우저 화면 API 테스트."""

import sqlalchemy as sa

from app.models import Base


def _seed(client, load_fixture) -> None:
    sid = client.post("/api/ingest/catalog", json=load_fixture("catalog.json")).json()["snapshot_id"]
    client.post("/api/ingest/view-deps",
                json={**load_fixture("view_deps.json"), "snapshot_id": sid})


def _object_id(client, qname: str) -> int:
    schema, name = qname.split(".", 1)
    items = client.get("/api/objects", params={"q": name, "limit": 1000}).json()["items"]
    return next(i["id"] for i in items if i["schema"] == schema and i["name"] == name)


def test_join_keys_aggregate_fk_and_view_joins(client, load_fixture):
    _seed(client, load_fixture)
    body = client.get("/api/join-keys").json()
    assert body["items"]
    top = body["items"][0]
    assert top["table_count"] >= 2 and top["usage"] >= top["table_count"]
    assert len(top["table_ids"]) == top["table_count"]
    # FK 페어 컬럼이 키로 잡혀야 한다 / an FK pair column must appear
    fk = load_fixture("catalog.json")["foreign_keys"][0]["columns"][0]
    keys = {i["key"] for i in body["items"]}
    assert fk["tgt_column"] in keys or fk["src_column"] in keys


def test_detail_reports_views_similars_and_relations(client, load_fixture):
    _seed(client, load_fixture)
    rel = next(r for r in load_fixture("expected/relations.json")["rows"]
               if r["kind"] == "fk")
    object_id = _object_id(client, rel["tgt_object"])

    body = client.get(f"/api/objects/{object_id}/detail").json()
    assert body["name"] == rel["tgt_object"]
    assert body["column_count"] == len(body["columns"])
    assert any(c["is_pk"] for c in body["columns"])
    # FK 자식이 fk_in에 잡혀야 한다 / the FK child appears as inbound
    assert rel["src_object"] in body["fk_in"]
    # 조인키 마킹 — PK는 항상 조인키 / PK columns are always join keys
    pk = next(c for c in body["columns"] if c["is_pk"])
    assert pk["is_join_key"] is True


def test_detail_using_views_from_lineage(client, load_fixture):
    _seed(client, load_fixture)
    row = next(r for r in load_fixture("expected/lineage_phase1.json")["rows"]
               if r["flag"] is None and r["depth"] == 1)
    object_id = _object_id(client, row["base"])
    body = client.get(f"/api/objects/{object_id}/detail").json()
    names = {v["name"] for v in body["using_views"]}
    assert row["view"] in names


def test_detail_similar_tables_have_rates(client, load_fixture):
    _seed(client, load_fixture)
    # audit 공통 컬럼 덕에 유사 테이블은 대부분 존재 / audit columns make similars common
    rel = load_fixture("expected/relations.json")["rows"][0]
    object_id = _object_id(client, rel["src_object"])
    body = client.get(f"/api/objects/{object_id}/detail").json()
    for s in body["similar_tables"]:
        assert 0.3 <= s["match_rate"] <= 1.0
        assert s["common_columns"] >= 1


def test_preview_caps_masks_and_audits(client, migrated_engine, load_fixture):
    _seed(client, load_fixture)
    rel = load_fixture("expected/relations.json")["rows"][0]
    object_id = _object_id(client, rel["src_object"])

    with migrated_engine.begin() as conn:
        col_t = Base.metadata.tables["columns"]
        obj_t = Base.metadata.tables["objects"]
        first_col = conn.execute(
            sa.select(col_t.c.id, col_t.c.name)
            .join(obj_t, col_t.c.object_id == obj_t.c.id)
            .where(obj_t.c.id == object_id).order_by(col_t.c.ordinal).limit(1)
        ).one()
        conn.execute(sa.update(col_t).where(col_t.c.id == first_col.id)
                     .values(masking_policy="full"))

    body = client.get(f"/api/objects/{object_id}/preview").json()
    assert len(body["rows"]) == 20
    assert body["columns"][0] == first_col.name
    assert body["masked_columns"] == [first_col.name]
    assert all(row[first_col.name] == "●●●" for row in body["rows"])
    # 관계 컬럼은 실제 값 집합에서 나온다 / relation columns draw from real value sets
    assert any(row[rel["src_column"]] not in (None, "") for row in body["rows"])

    with migrated_engine.connect() as conn:
        audits = conn.execute(
            sa.select(Base.metadata.tables["audit_logs"])
            .where(Base.metadata.tables["audit_logs"].c.action == "table_preview")
        ).all()
    assert len(audits) == 1 and rel["src_object"] in audits[0].detail
