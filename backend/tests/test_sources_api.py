"""소스 관리 API — 비밀 미노출·게이트·보호. / source admin API."""

import sqlite3

import pytest
from cryptography.fernet import Fernet

from app.config import get_settings

HEADERS = {"X-Preview-Password": "secret", "X-Dev-User": "admin.user"}


@pytest.fixture(autouse=True)
def _isolate_engine_cache():
    """소스별 엔진 캐시는 프로세스 전역이고 키가 소스 id다 — 각 테스트가 새 임시 DB를
    쓰면서 id가 2부터 재사용되므로, 앞 테스트가 남긴 캐시를 이번 테스트의 다른 파일을
    가리키는 소스가 그대로 물려받을 수 있다. 테스트 전후로 통째로 비워 격리한다
    (기존 관용은 고정 id 1건씩 앞뒤로 clear_sa_engine — 여기는 테스트마다 새 소스가
    여럿 생겨 전체를 비우는 편이 간단하다).
    """
    from app.sources.connection import _engines, _engines_lock

    def _wipe():
        with _engines_lock:
            for engine in _engines.values():
                engine.dispose()
            _engines.clear()

    _wipe()
    yield
    _wipe()


def _configure(monkeypatch):
    monkeypatch.setenv("PREVIEW_ADMIN_PASSWORD", "secret")
    monkeypatch.setenv("SOURCE_SECRET_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("DBV_SYSADMINS", "admin.user")
    get_settings.cache_clear()


def test_create_source_never_returns_the_password(client, monkeypatch):
    # Arrange
    _configure(monkeypatch)

    # Act
    res = client.post("/api/sources", headers=HEADERS, json={
        "name": "svca", "engine": "postgres", "host": "svca-db", "port": 5432,
        "database": "app", "username": "viewer", "password": "hunter2",
    })

    # Assert
    assert res.status_code == 200
    assert "hunter2" not in res.text
    assert "password" not in res.json()
    listed = client.get("/api/sources", headers=HEADERS).json()["items"]
    assert "hunter2" not in str(listed)
    get_settings.cache_clear()


def test_create_is_refused_without_a_secret_key(client, monkeypatch):
    # Arrange: 키가 없으면 평문 저장 대신 거부한다
    monkeypatch.setenv("PREVIEW_ADMIN_PASSWORD", "secret")
    monkeypatch.setenv("SOURCE_SECRET_KEY", "")
    monkeypatch.setenv("DBV_SYSADMINS", "admin.user")
    get_settings.cache_clear()

    # Act
    res = client.post("/api/sources", headers=HEADERS, json={
        "name": "svca", "engine": "postgres", "host": "h", "port": 5432,
        "database": "d", "username": "u", "password": "p",
    })

    # Assert
    assert res.status_code == 503
    get_settings.cache_clear()


def test_managed_source_cannot_be_edited_or_deleted(client, monkeypatch):
    # Arrange
    _configure(monkeypatch)

    # Act / Assert: 사내 MSSQL은 .env/n8n이 소유한다
    assert client.patch("/api/sources/1", headers=HEADERS,
                        json={"name": "x"}).status_code == 409
    assert client.delete("/api/sources/1", headers=HEADERS).status_code == 409
    get_settings.cache_clear()


def test_edit_requires_the_admin_password(client, monkeypatch):
    # Arrange
    _configure(monkeypatch)
    created = client.post("/api/sources", headers=HEADERS, json={
        "name": "svca", "engine": "sqlite", "file_path": "/tmp/a.db"}).json()

    # Act: 비밀번호 헤더 없이
    res = client.patch(f"/api/sources/{created['id']}",
                       headers={"X-Dev-User": "admin.user"}, json={"name": "svcb"})

    # Assert
    assert res.status_code in (401, 403, 503)
    get_settings.cache_clear()


def test_managed_source_still_listed_though_locked(client, monkeypatch):
    # Arrange: 목록 조회는 관리자 게이트만 필요 — 비밀번호 없이도 보인다
    _configure(monkeypatch)

    # Act
    items = client.get("/api/sources", headers=HEADERS).json()["items"]

    # Assert: 사내 MSSQL(id=1)이 여전히 목록에 있다
    assert any(item["id"] == 1 and item["is_managed"] for item in items)
    get_settings.cache_clear()


def test_password_never_leaks_via_patch_response(client, monkeypatch):
    # Arrange
    _configure(monkeypatch)
    created = client.post("/api/sources", headers=HEADERS, json={
        "name": "svcb", "engine": "sqlite", "file_path": "/tmp/b.db"}).json()

    # Act
    res = client.patch(f"/api/sources/{created['id']}", headers=HEADERS,
                       json={"password": "s3cr3t-patch"})

    # Assert
    assert res.status_code == 200
    assert "s3cr3t-patch" not in res.text
    assert "password" not in res.json()
    assert res.json()["has_password"] is True
    get_settings.cache_clear()


def test_update_is_refused_without_a_secret_key(client, monkeypatch):
    # Arrange: 소스는 키가 있을 때 만들고, 그 다음 키를 빼고 비밀번호만 바꾼다
    _configure(monkeypatch)
    created = client.post("/api/sources", headers=HEADERS, json={
        "name": "svcc", "engine": "sqlite", "file_path": "/tmp/c.db"}).json()
    monkeypatch.setenv("SOURCE_SECRET_KEY", "")
    get_settings.cache_clear()

    # Act
    res = client.patch(f"/api/sources/{created['id']}", headers=HEADERS,
                       json={"password": "newpass"})

    # Assert
    assert res.status_code == 503
    get_settings.cache_clear()


def test_delete_refused_when_snapshot_exists(client, monkeypatch, migrated_engine):
    # Arrange
    from datetime import UTC, datetime

    from sqlalchemy.orm import sessionmaker

    from app.models import Snapshot

    _configure(monkeypatch)
    created = client.post("/api/sources", headers=HEADERS, json={
        "name": "svcd", "engine": "sqlite", "file_path": "/tmp/d.db"}).json()
    with sessionmaker(bind=migrated_engine)() as db:
        db.add(Snapshot(collected_at=datetime.now(UTC), source_db="x",
                        status="ready", data_source_id=created["id"]))
        db.commit()

    # Act
    res = client.delete(f"/api/sources/{created['id']}", headers=HEADERS)

    # Assert
    assert res.status_code == 409
    get_settings.cache_clear()


def test_delete_refused_when_preview_allowlist_row_exists(client, monkeypatch, migrated_engine):
    # Arrange: 스냅샷이 없어도 정책 행만으로 삭제를 막는다 (이월 2) — FK가 없어
    # id가 재사용되면 낡은 허용이 새 소스에 적용될 수 있다
    from datetime import UTC, datetime

    from sqlalchemy.orm import sessionmaker

    from app.models import PreviewAllowlist

    _configure(monkeypatch)
    created = client.post("/api/sources", headers=HEADERS, json={
        "name": "svce", "engine": "sqlite", "file_path": "/tmp/e.db"}).json()
    with sessionmaker(bind=migrated_engine)() as db:
        db.add(PreviewAllowlist(data_source_id=created["id"], schema="dbo",
                                note=None, added_by="test", created_at=datetime.now(UTC)))
        db.commit()

    # Act
    res = client.delete(f"/api/sources/{created['id']}", headers=HEADERS)

    # Assert
    assert res.status_code == 409
    get_settings.cache_clear()


def test_delete_refused_when_schema_category_row_exists(client, monkeypatch, migrated_engine):
    # Arrange: 카테고리 매핑 행도 같은 이유로 삭제를 막는다 (이월 2)
    from datetime import UTC, datetime

    from sqlalchemy.orm import sessionmaker

    from app.models import SchemaCategory

    _configure(monkeypatch)
    created = client.post("/api/sources", headers=HEADERS, json={
        "name": "svcf", "engine": "sqlite", "file_path": "/tmp/f.db"}).json()
    with sessionmaker(bind=migrated_engine)() as db:
        db.add(SchemaCategory(data_source_id=created["id"], schema_name="dbo",
                              category="ATM", updated_by="test",
                              updated_at=datetime.now(UTC)))
        db.commit()

    # Act
    res = client.delete(f"/api/sources/{created['id']}", headers=HEADERS)

    # Assert
    assert res.status_code == 409
    get_settings.cache_clear()


def test_delete_succeeds_without_snapshots_or_policy_rows(client, monkeypatch):
    # Arrange
    _configure(monkeypatch)
    created = client.post("/api/sources", headers=HEADERS, json={
        "name": "svcg", "engine": "sqlite", "file_path": "/tmp/g.db"}).json()

    # Act
    res = client.delete(f"/api/sources/{created['id']}", headers=HEADERS)

    # Assert
    assert res.status_code == 200
    assert res.json() == {"id": created["id"], "removed": True}
    get_settings.cache_clear()


def test_patch_clears_cached_connection_engine(client, monkeypatch, tmp_path):
    # Arrange: 실접속으로 캐시를 채운 뒤 PATCH가 비우는지 확인 (이월 4)
    from app.sources.connection import _engines

    _configure(monkeypatch)
    db_path = tmp_path / "cache-patch.db"
    sqlite3.connect(str(db_path)).close()
    created = client.post("/api/sources", headers=HEADERS, json={
        "name": "svch", "engine": "sqlite", "file_path": str(db_path)}).json()
    sid = created["id"]
    assert client.post(f"/api/sources/{sid}/test", headers=HEADERS).status_code == 200
    assert sid in _engines

    # Act
    client.patch(f"/api/sources/{sid}", headers=HEADERS, json={"name": "svch2"})

    # Assert
    assert sid not in _engines
    get_settings.cache_clear()


def test_delete_clears_cached_connection_engine(client, monkeypatch, tmp_path):
    # Arrange
    from app.sources.connection import _engines

    _configure(monkeypatch)
    db_path = tmp_path / "cache-delete.db"
    sqlite3.connect(str(db_path)).close()
    created = client.post("/api/sources", headers=HEADERS, json={
        "name": "svci", "engine": "sqlite", "file_path": str(db_path)}).json()
    sid = created["id"]
    assert client.post(f"/api/sources/{sid}/test", headers=HEADERS).status_code == 200
    assert sid in _engines

    # Act
    client.delete(f"/api/sources/{sid}", headers=HEADERS)

    # Assert
    assert sid not in _engines
    get_settings.cache_clear()


def test_disabled_source_refuses_connection_test(client, monkeypatch):
    # Arrange: 비활성화하고 연결시도 — 조용히 동작하지 않고 명확히 거부한다 (이월 3)
    _configure(monkeypatch)
    created = client.post("/api/sources", headers=HEADERS, json={
        "name": "svcj", "engine": "sqlite", "file_path": "/tmp/does-not-matter.db"}).json()
    client.patch(f"/api/sources/{created['id']}", headers=HEADERS,
                json={"is_enabled": False})

    # Act
    res = client.post(f"/api/sources/{created['id']}/test", headers=HEADERS)

    # Assert: 연결을 실제로 시도하지도 않고 막힌다 (404가 아니라 409 — 소스는 존재)
    assert res.status_code == 409
    get_settings.cache_clear()


def test_disabled_source_still_listed_and_can_be_reenabled(client, monkeypatch):
    # Arrange: 비활성화해도 목록에는 남고, 다시 켤 수 있어야 한다 (이월 3)
    _configure(monkeypatch)
    created = client.post("/api/sources", headers=HEADERS, json={
        "name": "svck", "engine": "sqlite", "file_path": "/tmp/k.db"}).json()
    client.patch(f"/api/sources/{created['id']}", headers=HEADERS,
                json={"is_enabled": False})

    # Act
    items = client.get("/api/sources", headers=HEADERS).json()["items"]
    reenabled = client.patch(f"/api/sources/{created['id']}", headers=HEADERS,
                             json={"is_enabled": True})

    # Assert
    assert any(item["id"] == created["id"] and item["is_enabled"] is False
              for item in items)
    assert reenabled.json()["is_enabled"] is True
    get_settings.cache_clear()


def test_disabled_source_blocks_collect_trigger(client, monkeypatch):
    # Arrange: 비활성 소스로 수집을 트리거하면 동기적으로 명확히 거부된다 (이월 3)
    _configure(monkeypatch)
    created = client.post("/api/sources", headers=HEADERS, json={
        "name": "svcl", "engine": "sqlite", "file_path": "/tmp/l.db"}).json()
    client.patch(f"/api/sources/{created['id']}", headers=HEADERS,
                json={"is_enabled": False})

    # Act
    res = client.post("/api/collect/catalog", headers=HEADERS,
                      json={"source_id": created["id"]})

    # Assert
    assert res.status_code == 409
    get_settings.cache_clear()


def test_managed_source_test_reports_n8n_routing(client, monkeypatch):
    # Arrange: 사내 MSSQL은 n8n 경유라 직결 테스트 대상이 아니다
    _configure(monkeypatch)

    # Act
    res = client.post("/api/sources/1/test", headers=HEADERS)

    # Assert
    assert res.status_code == 400
    get_settings.cache_clear()


def test_connection_test_round_trip_against_real_sqlite_file(client, monkeypatch, tmp_path):
    # Arrange: 실제로 열리는 sqlite 파일로 성공 왕복을 확인한다
    _configure(monkeypatch)
    db_path = tmp_path / "ok.db"
    sqlite3.connect(str(db_path)).close()
    created = client.post("/api/sources", headers=HEADERS, json={
        "name": "svcm", "engine": "sqlite", "file_path": str(db_path)}).json()

    # Act
    res = client.post(f"/api/sources/{created['id']}/test", headers=HEADERS)

    # Assert
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert "database" in body and "version" in body
    get_settings.cache_clear()


def test_connection_test_failure_does_not_leak_driver_text(client, monkeypatch):
    # Arrange: 존재하지 않는 파일 — 실접속 실패를 유발한다
    _configure(monkeypatch)
    created = client.post("/api/sources", headers=HEADERS, json={
        "name": "svcn", "engine": "sqlite",
        "file_path": "/tmp/does-not-exist-xyz-12345.db"}).json()

    # Act
    res = client.post(f"/api/sources/{created['id']}/test", headers=HEADERS)

    # Assert: 502이고, 드라이버 원문(파일 경로 등)이 응답에 없다 — 종류만 노출
    assert res.status_code == 502
    assert "does-not-exist-xyz-12345" not in res.text
    assert "sqlite3" not in res.text.lower()

    # 실패 기록(last_error)도 응답과 같은 규칙을 지킨다 — 종류만 저장, 원문은 저장 안 함.
    # get_db는 라우트 예외를 받으면 세션을 롤백하므로, 엔드포인트가 예외를 던지기 전에
    # 커밋해 두지 않으면 이 기록 자체가 통째로 사라진다(직접 확인한 버그 — 이 assert가
    # 그 회귀를 잡는다)
    listed = client.get("/api/sources", headers=HEADERS).json()["items"]
    entry = next(item for item in listed if item["id"] == created["id"])
    assert entry["last_error"] == "OperationalError"
    assert "does-not-exist-xyz-12345" not in str(entry["last_error"])
    get_settings.cache_clear()
