"""직결 미리보기 실행 — 실제 SQLite 파일로 왕복. / direct preview against a real SQLite file."""

import sqlite3
from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models import CatalogColumn, CatalogObject, DataSource, PreviewAllowlist, Snapshot
from app.sources.direct_preview import DirectTablePreview

COLUMNS = [{"name": "id", "data_type": "INTEGER"},
           {"name": "status", "data_type": "TEXT"}]


@pytest.fixture()
def sqlite_source(tmp_path):
    # Arrange: 실 데이터가 든 SQLite 파일
    path = tmp_path / "app.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT)")
    conn.executemany("INSERT INTO orders VALUES (?, ?)",
                     [(1, "PAID"), (2, "pending"), (3, None)])
    conn.commit()
    conn.close()
    now = datetime.now(UTC)
    source = DataSource(id=99, name="t", engine="sqlite", access_mode="direct",
                        file_path=str(path), is_enabled=True, is_managed=False,
                        created_at=now, updated_at=now)
    return source, create_engine(f"sqlite:///file:{path}?mode=ro&uri=true")


def test_returns_rows_without_filters(sqlite_source):
    # Arrange
    _, engine = sqlite_source
    preview = DirectTablePreview(engine)

    # Act
    rows = preview.rows("main.orders", COLUMNS, 20)

    # Assert
    assert [r["id"] for r in rows] == [1, 2, 3]


def test_filter_is_case_insensitive(sqlite_source):
    # Arrange
    _, engine = sqlite_source
    preview = DirectTablePreview(engine)

    # Act: 저장된 값은 'PAID', 입력은 소문자
    rows = preview.rows("main.orders", COLUMNS, 20,
                        filters=[{"column": "status", "op": "eq", "value": "paid"}])

    # Assert
    assert [r["id"] for r in rows] == [1]


def test_not_contains_includes_null_rows(sqlite_source):
    # Arrange
    _, engine = sqlite_source
    preview = DirectTablePreview(engine)

    # Act
    rows = preview.rows("main.orders", COLUMNS, 20,
                        filters=[{"column": "status", "op": "not_contains",
                                  "value": "paid"}])

    # Assert: NULL 행(3)이 빠지지 않는다 — fixture 의미와 동등
    assert [r["id"] for r in rows] == [2, 3]


def test_limit_is_applied(sqlite_source):
    # Arrange
    _, engine = sqlite_source
    preview = DirectTablePreview(engine)

    # Act
    rows = preview.rows("main.orders", COLUMNS, 2)

    # Assert
    assert len(rows) == 2


def _seed_broken_direct_source(migrated_engine, missing_path: str) -> int:
    """존재하지 않는 파일을 가리키는 direct sqlite 소스 + 스냅샷/객체/컬럼/allowlist.

    반환은 object_id — /preview 호출에 그대로 쓴다. 소스·스키마명은 이 테스트 전용이라
    다른 테스트(managed 소스 id=1)와 충돌하지 않는다.
    """
    now = datetime.now(UTC)
    with sessionmaker(bind=migrated_engine)() as db:
        source = DataSource(name="broken", engine="sqlite", access_mode="direct",
                            file_path=missing_path, is_enabled=True, is_managed=False,
                            created_at=now, updated_at=now)
        db.add(source)
        db.flush()
        snapshot = Snapshot(collected_at=now, source_db="broken", status="ready",
                            data_source_id=source.id)
        db.add(snapshot)
        db.flush()
        obj = CatalogObject(snapshot_id=snapshot.id, schema="main", name="orders",
                            type="table", object_id=1, row_count=None)
        db.add(obj)
        db.flush()
        db.add(CatalogColumn(object_id=obj.id, name="id", ordinal=1, data_type="INTEGER",
                             max_length=4, is_nullable=False, is_pk=True, is_computed=False))
        db.add(PreviewAllowlist(data_source_id=source.id, schema="main", note=None,
                                added_by="test", created_at=now))
        db.commit()
        return obj.id


def test_broken_source_returns_502_not_500(client, migrated_engine, tmp_path):
    # Arrange: 파일이 없는 sqlite 소스 + 그 소스의 스냅샷/객체/allowlist
    missing_path = str(tmp_path / "does-not-exist.db")
    object_id = _seed_broken_direct_source(migrated_engine, missing_path)

    # Act
    res = client.get(f"/api/objects/{object_id}/preview")

    # Assert: 500(미처리 예외)이 아니라 502로 격리된다 — 이 소스만 실패한다
    assert res.status_code == 502
    body = res.json()
    assert "could not be queried" in body["error"]["message"]
