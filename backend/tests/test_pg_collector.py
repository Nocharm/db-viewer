"""PostgreSQL 수집기 — oid 매핑과 실 DB 왕복.
/ Postgres collector: oid mapping and a live round-trip."""

import os

import pytest
from sqlalchemy import create_engine, text

from app.sources.pg_collector import collect_postgres, map_oids_to_object_ids

PG_URL = os.environ.get("TEST_POSTGRES_URL")
requires_pg = pytest.mark.skipif(not PG_URL, reason="TEST_POSTGRES_URL is not set")


def test_maps_oids_to_sequential_object_ids():
    # Arrange: oid는 int4를 넘길 수 있어 그대로 쓰지 않는다
    oids = [4294967290, 17, 999]

    # Act
    mapping = map_oids_to_object_ids(oids)

    # Assert: 1부터의 일련번호, 입력 순서 유지
    assert mapping == {4294967290: 1, 17: 2, 999: 3}


@requires_pg
def test_collects_tables_columns_and_fks():
    # Arrange
    engine = create_engine(PG_URL)
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA IF EXISTS collect_probe CASCADE"))
        conn.execute(text("CREATE SCHEMA collect_probe"))
        conn.execute(text("CREATE TABLE collect_probe.parent "
                          "(id integer PRIMARY KEY, label varchar(50))"))
        conn.execute(text("CREATE TABLE collect_probe.child "
                          "(id integer PRIMARY KEY, "
                          " parent_id integer REFERENCES collect_probe.parent(id))"))
        conn.execute(text("CREATE VIEW collect_probe.v_child AS "
                          "SELECT id FROM collect_probe.child"))

    # Act
    payload = collect_postgres(engine, "probe")

    # Assert
    names = {(o.schema_name, o.name, o.type) for o in payload.objects
             if o.schema_name == "collect_probe"}
    assert names == {("collect_probe", "parent", "table"),
                     ("collect_probe", "child", "table"),
                     ("collect_probe", "v_child", "view")}

    label = next(c for c in payload.columns
                 if c.name == "label" and c.object_id in
                 {o.object_id for o in payload.objects if o.name == "parent"})
    assert label.data_type == "character varying(50)"
    assert label.max_length == 50
    assert label.is_nullable is True

    fk = next(f for f in payload.foreign_keys)
    assert [(p.src_column, p.tgt_column) for p in fk.columns] == [("parent_id", "id")]

    view = next(o for o in payload.objects if o.name == "v_child")
    definition = next(d for d in payload.view_definitions
                      if d.object_id == view.object_id)
    assert "child" in (definition.definition or "")

    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA collect_probe CASCADE"))
