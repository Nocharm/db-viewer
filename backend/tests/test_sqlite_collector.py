"""SQLite 수집기 — 실제 파일로 왕복. / SQLite collector against a real file."""

import sqlite3

import pytest
from sqlalchemy import Engine, create_engine

from app.sources.sqlite_collector import build_fk_name, collect_sqlite


def _make_engine(tmp_path, script: str, name: str) -> Engine:
    """스크립트를 실행한 SQLite 파일을 읽기 전용 엔진으로 연다."""
    path = tmp_path / name
    conn = sqlite3.connect(path)
    conn.executescript(script)
    conn.commit()
    conn.close()
    return create_engine(f"sqlite:///file:{path}?mode=ro&uri=true")


@pytest.fixture()
def sample_db(tmp_path) -> Engine:
    # Arrange
    return _make_engine(tmp_path, """
        CREATE TABLE parent (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
        CREATE TABLE child (
            id INTEGER PRIMARY KEY,
            parent_id INTEGER REFERENCES parent
        );
        CREATE VIEW v_child AS SELECT id FROM child;
        INSERT INTO parent VALUES (1, 'a'), (2, 'b');
    """, "app.db")


def test_collects_objects_with_main_schema(sample_db):
    # Act
    payload = collect_sqlite(sample_db, "svcc")

    # Assert: SQLite에는 스키마가 없다 — 'main'으로 고정한다
    assert {(o.schema_name, o.name, o.type) for o in payload.objects} == {
        ("main", "parent", "table"), ("main", "child", "table"),
        ("main", "v_child", "view"),
    }
    parent = next(o for o in payload.objects if o.name == "parent")
    assert parent.row_count == 2


def test_collects_columns_and_primary_key(sample_db):
    # Act
    payload = collect_sqlite(sample_db, "svcc")
    parent_id = next(o.object_id for o in payload.objects if o.name == "parent")

    # Assert
    label = next(c for c in payload.columns
                 if c.object_id == parent_id and c.name == "label")
    assert label.data_type == "TEXT"
    assert label.is_nullable is False
    assert label.max_length == -1

    pk = next(k for k in payload.key_constraints if k.object_id == parent_id)
    assert pk.type == "pk"
    assert pk.columns == ["id"]

    # Assert: ordinal은 1-base — table_info의 cid(0-base)를 그대로 안 쓴다.
    # pg_collector의 attnum(1-base, MSSQL column_id와 같은 관례)에 맞춘다.
    id_col = next(c for c in payload.columns
                  if c.object_id == parent_id and c.name == "id")
    assert id_col.ordinal == 1
    assert label.ordinal == 2


def test_resolves_implicit_fk_target_to_primary_key(sample_db):
    # Act: `child.parent_id REFERENCES parent` — 대상 컬럼을 생략한 진짜 암묵 참조.
    # PRAGMA foreign_key_list가 이 DDL에 대해 to=NULL을 돌려주므로 _resolve_fk_pairs의
    # PK 폴백 경로를 실제로 지나간다.
    payload = collect_sqlite(sample_db, "svcc")

    # Assert
    fk = next(iter(payload.foreign_keys))
    assert [(p.src_column, p.tgt_column) for p in fk.columns] == [("parent_id", "id")]


def test_collects_view_definition(sample_db):
    # Act
    payload = collect_sqlite(sample_db, "svcc")

    # Assert: 뷰는 COUNT를 돌리지 않는다 — row_count는 의미가 없어 None으로 둔다
    view = next(o for o in payload.objects if o.name == "v_child")
    assert view.row_count is None
    definition = next(d for d in payload.view_definitions if d.object_id == view.object_id)
    assert "child" in (definition.definition or "")


@pytest.fixture()
def probe_db(tmp_path) -> Engine:
    """parent2/child2는 자연 컬럼 순서(x,y / a,b)와 반대로 FK를 걸어(b,a)->(y,x) 둔다 —
    seq 정렬이 빠지면 우연히 맞는 순서가 나오기 어렵게 함정을 드러내려는 의도(PG 수집기와 동일 패턴).
    no_pk_target/implicit_ref는 PK가 없는 테이블에 대한 암묵 참조 — 자리를 해석할 PK가 없어
    FK 전체가 버려져야 한다. orphan은 존재하지 않는 테이블(ghost)을 참조한다.
    auto_tbl은 AUTOINCREMENT로 sqlite_sequence 내부 테이블을 만들어 필터링을 검증한다.
    """
    return _make_engine(tmp_path, """
        CREATE TABLE parent2 (x INTEGER, y INTEGER, PRIMARY KEY (x, y));
        CREATE TABLE child2 (a INTEGER, b INTEGER,
                             FOREIGN KEY (b, a) REFERENCES parent2(y, x));
        CREATE TABLE no_pk_target (id INTEGER, val TEXT);
        CREATE TABLE implicit_ref (ref_id INTEGER REFERENCES no_pk_target);
        CREATE TABLE orphan (id INTEGER REFERENCES ghost(id));
        CREATE TABLE auto_tbl (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT);
    """, "probe.db")


def test_composite_fk_preserves_declaration_order(probe_db):
    # Act
    payload = collect_sqlite(probe_db, "svcc")

    # Assert: FK 페어가 선언 순서(b,a)->(y,x) 그대로 나온다 — 정렬이 깨지면
    # [("a","x"), ("b","y")]로 뒤집혀 실패한다
    fk2 = next(f for f in payload.foreign_keys if len(f.columns) == 2)
    assert [(p.src_column, p.tgt_column) for p in fk2.columns] == [("b", "y"), ("a", "x")]

    # Assert: PK 컬럼도 선언 순서(x, y) 그대로
    pk2 = next(k for k in payload.key_constraints if k.type == "pk" and
              k.object_id in {o.object_id for o in payload.objects if o.name == "parent2"})
    assert pk2.columns == ["x", "y"]


def test_drops_fk_with_unresolvable_column(probe_db):
    # Act: no_pk_target에 PK가 없어 implicit_ref의 암묵 참조를 해석할 자리가 없다
    payload = collect_sqlite(probe_db, "svcc")

    # Assert: FK 전체가 버려진다 (부분 페어만 남기지 않는다)
    implicit_ref_id = next(o.object_id for o in payload.objects if o.name == "implicit_ref")
    assert not any(fk.src_object_id == implicit_ref_id for fk in payload.foreign_keys)


def test_drops_fk_targeting_missing_table(probe_db):
    # Act: orphan은 카탈로그에 없는 테이블(ghost)을 참조한다
    payload = collect_sqlite(probe_db, "svcc")

    # Assert
    orphan_id = next(o.object_id for o in payload.objects if o.name == "orphan")
    assert not any(fk.src_object_id == orphan_id for fk in payload.foreign_keys)


def test_excludes_internal_sqlite_objects(probe_db):
    # Act: AUTOINCREMENT가 만드는 sqlite_sequence는 내부 객체다
    payload = collect_sqlite(probe_db, "svcc")

    # Assert
    assert not any(o.name.startswith("sqlite_") for o in payload.objects)


def test_fk_name_fits_the_constraint_column_and_keeps_the_id_suffix():
    """긴 테이블명 두 개를 이어도 `constraints.name`(varchar 128)을 넘지 않는다.

    넘기면 PostgreSQL이 "value too long"으로 적재 전체를 실패시킨다 — SQLite는 조용히
    받아들여 개발 중에는 보이지 않는다. `_{id}` 접미사는 같은 대상으로 걸린 FK들을
    구분하는 유일한 조각이라 잘림에 관계없이 남아야 한다.
    """
    # Arrange: 각각 100자짜리 테이블명 두 개
    src, tgt = "s" * 100, "t" * 100

    # Act
    first = build_fk_name(src, tgt, 0)
    second = build_fk_name(src, tgt, 1)

    # Assert
    assert len(first) <= 128
    assert first.endswith("_0") and second.endswith("_1")
    assert first != second
    # 짧은 쪽은 잘리지 않고, 남은 자리를 긴 쪽이 가져간다 (128 - "_7" - 사이의 "_" = 125)
    lopsided = build_fk_name("short", "t" * 200, 7)
    assert lopsided == f"short_{'t' * 120}_7" and len(lopsided) == 128
    # 폭 안에 들어가는 평범한 이름은 원본 그대로
    assert build_fk_name("child", "parent", 0) == "child_parent_0"
