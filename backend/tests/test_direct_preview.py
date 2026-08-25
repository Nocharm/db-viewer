"""직결 미리보기 실행 — 실제 SQLite 파일로 왕복. / direct preview against a real SQLite file."""

import sqlite3
from datetime import UTC, datetime

import pytest
from sqlalchemy.orm import sessionmaker

from app.api import objects
from app.config import get_settings
from app.models import CatalogColumn, CatalogObject, DataSource, PreviewAllowlist, Snapshot
from app.sources.connection import clear_sa_engine, get_sa_engine
from app.sources.direct_preview import DirectTablePreview
from app.sources.preview_sql import UnknownIdentifier

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
    # get_sa_engine을 실제로 거친다(build_sa_url 배선이 해피패스에서도 돌게) — 캐시는
    # source.id로 키가 잡히고 이 id는 테스트마다 고정(99)이라, 이전 테스트가 남긴 엔진이
    # 이번 테스트의(다른 tmp_path) 파일을 대신 가리키지 않도록 앞뒤로 비운다
    clear_sa_engine(source.id)
    yield source, get_sa_engine(source)
    clear_sa_engine(source.id)


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


def _seed_direct_sqlite_source(migrated_engine, name: str, file_path: str) -> int:
    """direct sqlite 소스 1건 + 스냅샷/객체/컬럼/allowlist. 반환은 object_id.

    소스·스키마명은 이 테스트 전용이라 다른 테스트(managed 소스 id=1)와 충돌하지 않는다.
    source.id는 자동증가라 같은 pytest 세션의 다른 테스트와 정수가 겹칠 수 있다 —
    get_sa_engine의 전역 캐시가 그 낡은(다른 파일을 가리키는) 엔진을 돌려주지 않도록 비운다.
    """
    now = datetime.now(UTC)
    with sessionmaker(bind=migrated_engine)() as db:
        source = DataSource(name=name, engine="sqlite", access_mode="direct",
                            file_path=file_path, is_enabled=True, is_managed=False,
                            created_at=now, updated_at=now)
        db.add(source)
        db.flush()
        clear_sa_engine(source.id)
        snapshot = Snapshot(collected_at=now, source_db=name, status="ready",
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
    # Arrange: 파일이 없는 sqlite 소스 + 정상 동작하는 sqlite 소스(스냅샷/객체/allowlist 포함) —
    # 후자가 있어야 "다른 소스는 멀쩡하다"를 실제로 증명할 수 있다
    missing_path = str(tmp_path / "does-not-exist.db")
    broken_id = _seed_direct_sqlite_source(migrated_engine, "broken", missing_path)

    healthy_path = tmp_path / "healthy.db"
    conn = sqlite3.connect(healthy_path)
    conn.execute("CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT)")
    conn.execute("INSERT INTO orders VALUES (1, 'PAID')")
    conn.commit()
    conn.close()
    healthy_id = _seed_direct_sqlite_source(migrated_engine, "healthy", str(healthy_path))

    # Act
    broken_res = client.get(f"/api/objects/{broken_id}/preview")
    healthy_res = client.get(f"/api/objects/{healthy_id}/preview")

    # Assert: 500(미처리 예외)이 아니라 502로 격리된다 — 이 소스만 실패한다
    assert broken_res.status_code == 502
    body = broken_res.json()
    assert "could not be queried" in body["error"]["message"]
    # 다른(정상) 소스는 멀쩡하다 — 실패가 앱 전체로 번지지 않는다
    assert healthy_res.status_code == 200


def test_missing_secret_key_returns_503_not_500(client, migrated_engine, monkeypatch):
    """SOURCE_SECRET_KEY 미설정(키 교체 직후 포함) 상태에서 500으로 새지 않는지.

    비밀번호가 저장된 direct 소스는 build_sa_url -> decrypt_secret에서 CryptoNotConfigured를
    올린다. 이건 그 소스의 장애(502)가 아니라 이쪽 배포 설정 문제라 503으로 구분돼야 하고,
    무엇보다 무처리 500으로 새면 관리자가 원인을 화면에서 알 수 없다.
    """
    # Arrange: SOURCE_SECRET_KEY를 비운다(키 교체 직후와 같은 상태) + 비밀번호가 있는 postgres 소스
    monkeypatch.setenv("SOURCE_SECRET_KEY", "")
    get_settings.cache_clear()
    now = datetime.now(UTC)
    with sessionmaker(bind=migrated_engine)() as db:
        source = DataSource(name="needs-secret", engine="postgres", access_mode="direct",
                            host="h", port=5432, database="d", username="u",
                            password_enc="ciphertext-from-before-the-rotation",
                            is_enabled=True, is_managed=False,
                            created_at=now, updated_at=now)
        db.add(source)
        db.flush()
        # source.id는 자동증가라 다른 테스트와 정수가 겹칠 수 있다 — get_sa_engine의 전역
        # 캐시가 그 낡은 엔진을 돌려주면 build_sa_url/decrypt_secret이 아예 안 불려 이 테스트가
        # 검증하려는 경로를 못 탄다(_seed_direct_sqlite_source와 같은 이유의 같은 조치)
        clear_sa_engine(source.id)
        snapshot = Snapshot(collected_at=now, source_db="needs-secret", status="ready",
                            data_source_id=source.id)
        db.add(snapshot)
        db.flush()
        obj = CatalogObject(snapshot_id=snapshot.id, schema="pub", name="orders",
                            type="table", object_id=1, row_count=None)
        db.add(obj)
        db.flush()
        db.add(CatalogColumn(object_id=obj.id, name="id", ordinal=1, data_type="INTEGER",
                             max_length=4, is_nullable=False, is_pk=True, is_computed=False))
        db.add(PreviewAllowlist(data_source_id=source.id, schema="pub", note=None,
                                added_by="test", created_at=now))
        db.commit()
        object_id = obj.id

    try:
        # Act
        res = client.get(f"/api/objects/{object_id}/preview")
    finally:
        get_settings.cache_clear()

    # Assert: 미처리 500이 아니라 503으로 명시적으로 거부되고, 메시지가 원인(키 미설정)을 남긴다
    assert res.status_code == 503
    assert "SOURCE_SECRET_KEY" in res.json()["error"]["message"]


def test_assembly_bug_is_not_reported_as_a_source_failure(
    client, migrated_engine, monkeypatch
):
    """조립 단계 버그(build_preview_sql의 UnknownIdentifier 같은 ValueError)는 DBAPIError가
    아니므로 502(소스 탓)로 위장돼선 안 된다 — 502를 SQLAlchemyError 전체가 아니라 DBAPIError로
    좁힌 이유를 직접 확인한다.

    실제 엔드포인트에서 필터 컬럼은 parse_preview_filters가 카탈로그와 대조해 400으로 먼저
    거르므로 UnknownIdentifier가 자연 상태로 여기까지 올 경로는 없다 — create_table_preview가
    돌려주는 실행기 자체가 조립 버그를 냈다고 가정해(fault injection) objects.py의 except 절이
    그걸 502로 오분류하지 않는지 확인한다.
    """
    # Arrange: 정상적인 direct 소스(카탈로그·allowlist까지) + create_table_preview가 조립
    # 버그를 낸다고 가정
    object_id = _seed_direct_sqlite_source(migrated_engine, "assembly-bug",
                                           "/nonexistent/unused.db")

    def _raise_unknown_identifier(settings, source=None):
        raise UnknownIdentifier("column not in the catalog: ghost")

    monkeypatch.setattr(objects, "create_table_preview", _raise_unknown_identifier)

    # Act / Assert: DBAPIError가 아니라서 502 핸들러가 잡지 않는다 — 미처리로 드러난다
    # (TestClient 기본값 raise_server_exceptions=True라 그대로 재발생하고, 502로 둔갑하지 않는다)
    with pytest.raises(UnknownIdentifier):
        client.get(f"/api/objects/{object_id}/preview")
