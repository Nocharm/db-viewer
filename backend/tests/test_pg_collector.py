"""PostgreSQL 수집기 — oid 매핑과 실 DB 왕복.
/ Postgres collector: oid mapping and a live round-trip."""

import os

import pytest
from sqlalchemy import Engine, create_engine, text

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


@pytest.fixture()
def probe_catalog() -> Engine:
    """collect_probe 스키마 생성/정리 — teardown은 assertion 실패에도 반드시 돈다.

    parent2/child2는 자연 컬럼 순서(x,y / a,b)와 반대로 FK를 걸어(b,a)->(y,x) 둔다 —
    ARRAY(...) 서브쿼리 안의 ORDER BY u.ord가 빠지면 우연히 맞는 순서가 나오기 어렵게
    함정을 드러내려는 의도.

    mv_child(matview)는 v_child(일반 뷰)와 짝을 이뤄 row_count 처리가 갈리는 것을 보인다 —
    단 CREATE MATERIALIZED VIEW ... WITH DATA 자체는 reltuples를 안 갱신한다(실측: 생성
    직후에도 -1, 테이블과 동일). matview가 일반 뷰와 다른 지점은 ANALYZE가 통한다는 것
    (일반 뷰는 "cannot analyze non-tables"로 거부됨) — 그래서 명시적으로 ANALYZE해 둔다.
    """
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
        conn.execute(text("INSERT INTO collect_probe.parent VALUES (1, 'a'), (2, 'b')"))
        conn.execute(text("INSERT INTO collect_probe.child (id, parent_id) "
                          "VALUES (1, 1), (2, 2)"))
        conn.execute(text("CREATE MATERIALIZED VIEW collect_probe.mv_child AS "
                          "SELECT id FROM collect_probe.child WITH DATA"))
        # matview는 저장소가 있어 ANALYZE가 통한다(일반 뷰는 거부된다) — 이걸 해야
        # reltuples가 -1(미분석)에서 실제 행수로 바뀐다. CREATE만으로는 안 바뀐다.
        conn.execute(text("ANALYZE collect_probe.mv_child"))
        conn.execute(text("CREATE TABLE collect_probe.parent2 "
                          "(x integer, y integer, PRIMARY KEY (x, y))"))
        conn.execute(text("CREATE TABLE collect_probe.child2 "
                          "(a integer, b integer, "
                          " FOREIGN KEY (b, a) REFERENCES collect_probe.parent2(y, x))"))
    yield engine
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA IF EXISTS collect_probe CASCADE"))


@requires_pg
def test_collects_tables_columns_and_fks(probe_catalog: Engine):
    # Arrange: probe_catalog 픽스처가 스키마를 만들고 테스트 종료 시(실패 포함) 지운다

    # Act
    payload = collect_postgres(probe_catalog, "probe")

    # Assert
    names = {(o.schema_name, o.name, o.type) for o in payload.objects
             if o.schema_name == "collect_probe"}
    assert names == {("collect_probe", "parent", "table"),
                     ("collect_probe", "child", "table"),
                     ("collect_probe", "v_child", "view"),
                     ("collect_probe", "mv_child", "view"),
                     ("collect_probe", "parent2", "table"),
                     ("collect_probe", "child2", "table")}

    label = next(c for c in payload.columns
                 if c.name == "label" and c.object_id in
                 {o.object_id for o in payload.objects if o.name == "parent"})
    assert label.data_type == "character varying(50)"
    assert label.max_length == 50
    assert label.is_nullable is True

    fk = next(f for f in payload.foreign_keys if len(f.columns) == 1)
    assert [(p.src_column, p.tgt_column) for p in fk.columns] == [("parent_id", "id")]

    view = next(o for o in payload.objects if o.name == "v_child")
    definition = next(d for d in payload.view_definitions
                      if d.object_id == view.object_id)
    assert "child" in (definition.definition or "")
    # 일반 뷰는 저장된 카디널리티가 없다 — row_count는 항상 NULL로 나가야 한다
    assert view.row_count is None

    # matview는 다르다 — ANALYZE가 통해(픽스처에서 실행) reltuples가 실제 행수를 담는다.
    # child에 넣은 2행이 mv_child에 그대로 반영되는지까지 확인한다(작은 테이블에서
    # ANALYZE는 표본이 아니라 전수를 보므로 정확값을 기대할 수 있다 — 그래도 reltuples가
    # 원리상 추정치 타입이라는 점을 감안해 None이 아니고 음수가 아닌지도 함께 본다).
    matview = next(o for o in payload.objects if o.name == "mv_child")
    assert matview.type == "view"
    assert matview.row_count is not None
    assert matview.row_count >= 0
    assert matview.row_count == 2


@requires_pg
def test_composite_fk_and_pk_preserve_column_order(probe_catalog: Engine):
    # Arrange: probe_catalog가 parent2(x,y PK)/child2((b,a)->(y,x) FK)를 만든다 — FK 선언
    # 순서가 테이블의 자연 컬럼 순서와 반대라 내부 ORDER BY 누락 시 정렬이 깨지기 쉽다

    # Act
    payload = collect_postgres(probe_catalog, "probe")

    # Assert: FK 페어가 선언 순서(b,a)->(y,x) 그대로 나온다 — 정렬이 깨지면
    # [("a","x"), ("b","y")]로 뒤집혀 실패한다
    fk2 = next(f for f in payload.foreign_keys if len(f.columns) == 2)
    assert [(p.src_column, p.tgt_column) for p in fk2.columns] == [("b", "y"), ("a", "x")]

    # Assert: PK 컬럼도 선언 순서(x, y) 그대로 — _KEYS_SQL이 같은 ARRAY(...ORDER BY) 구조
    pk2 = next(k for k in payload.key_constraints
               if k.type == "pk" and k.object_id in
               {o.object_id for o in payload.objects if o.name == "parent2"})
    assert pk2.columns == ["x", "y"]
