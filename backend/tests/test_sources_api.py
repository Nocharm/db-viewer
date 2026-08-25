"""소스 관리 API — 비밀 미노출·게이트·보호. / source admin API."""

import sqlite3
from datetime import UTC, datetime

import pytest
from cryptography.fernet import Fernet
from sqlalchemy.orm import sessionmaker

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
    # 원문 응답 텍스트로 확인 — 파싱된 items만 보면 그 바깥(secret_key_configured,
    # 나중에 추가될 최상위 필드)이 안 걸린다 (리뷰 M6)
    assert "hunter2" not in client.get("/api/sources", headers=HEADERS).text
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


def test_disabled_source_allows_connection_test(client, monkeypatch, tmp_path):
    # Arrange: 비활성화한 소스 — 정상 운영 순서는 "자격증명을 고치고 → 테스트로
    # 확인하고 → 재활성화"라 테스트 자체를 막으면 확인 없이 먼저 켜야 하는 반대
    # 순서를 강제하게 된다 (리뷰 I1). 미리보기·수집 트리거는 여전히 막힌다 —
    # 이 테스트는 /test만 예외임을 확인한다
    _configure(monkeypatch)
    db_path = tmp_path / "disabled-but-testable.db"
    sqlite3.connect(str(db_path)).close()
    created = client.post("/api/sources", headers=HEADERS, json={
        "name": "svcj", "engine": "sqlite", "file_path": str(db_path)}).json()
    client.patch(f"/api/sources/{created['id']}", headers=HEADERS,
                json={"is_enabled": False})

    # Act
    res = client.post(f"/api/sources/{created['id']}/test", headers=HEADERS)
    collect_res = client.post("/api/collect/catalog", headers=HEADERS,
                              json={"source_id": created["id"]})

    # Assert: 연결 테스트는 통과(200) — 실접속을 실제로 시도해 성공한다.
    # 수집 트리거는 여전히 409 — 라이브 연결이 실제로 걸리는 경로만 막힌다
    assert res.status_code == 200
    assert res.json()["ok"] is True
    assert collect_res.status_code == 409
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


def test_validation_error_redacts_non_string_password(client, monkeypatch):
    # Arrange: 리뷰 C1 — 422 핸들러가 jsonable_encoder(exc.errors())를 그대로 실어
    # pydantic이 거부한 원본값(input)을 되비춘다. 숫자 비밀번호(프론트가 Number(input)을
    # 하거나 httpie `password:=`를 쓸 때의 현실적 트리거)와 리스트 둘 다 확인한다
    _configure(monkeypatch)

    # Act
    list_res = client.post("/api/sources", headers=HEADERS, json={
        "name": "svcp", "engine": "postgres", "host": "h", "port": 5432,
        "database": "d", "username": "u", "password": ["hunter2"]})
    numeric_res = client.post("/api/sources", headers=HEADERS, json={
        "name": "svcq", "engine": "postgres", "host": "h", "port": 5432,
        "database": "d", "username": "u", "password": 12345678})

    # Assert
    assert list_res.status_code == 422
    assert "hunter2" not in list_res.text
    assert numeric_res.status_code == 422
    assert "12345678" not in numeric_res.text
    get_settings.cache_clear()


def test_patch_validation_error_redacts_password_too(client, monkeypatch):
    # Arrange: C1은 password: str | None을 받는 두 엔드포인트(POST/PATCH) 모두에서
    # 도달 가능하다고 지적했다 — PATCH 경로도 확인한다
    _configure(monkeypatch)
    created = client.post("/api/sources", headers=HEADERS, json={
        "name": "svcs", "engine": "sqlite", "file_path": "/tmp/s.db"}).json()

    # Act
    res = client.patch(f"/api/sources/{created['id']}", headers=HEADERS,
                       json={"password": 999999})

    # Assert
    assert res.status_code == 422
    assert "999999" not in res.text
    get_settings.cache_clear()


def test_validation_error_keeps_diagnostic_value_for_non_secret_fields(client, monkeypatch):
    # Arrange: 리댁션이 password 필드만 지워야 한다 — port 같은 다른 필드의 진단값은
    # 그대로 남아야 오류 원인을 알 수 있다
    _configure(monkeypatch)

    # Act
    res = client.post("/api/sources", headers=HEADERS, json={
        "name": "svct", "engine": "postgres", "host": "h", "port": "not-a-port",
        "database": "d", "username": "u"})

    # Assert
    assert res.status_code == 422
    assert "not-a-port" in res.text
    get_settings.cache_clear()


def test_disabled_source_test_still_blocks_collect_and_preview(client, monkeypatch):
    # Arrange: I1 수정(get_source allow_disabled=True)이 /test에만 적용되고 수집
    # 트리거는 여전히 막히는지 명시적으로 재확인 — test_disabled_source_blocks_collect_trigger
    # 와 같은 취지를 이 테스트 파일 안에서 중복 확인해 회귀를 잡는다
    _configure(monkeypatch)
    created = client.post("/api/sources", headers=HEADERS, json={
        "name": "svcu", "engine": "sqlite", "file_path": "/tmp/u.db"}).json()
    client.patch(f"/api/sources/{created['id']}", headers=HEADERS,
                json={"is_enabled": False})

    # Act
    res = client.post("/api/collect/catalog", headers=HEADERS,
                      json={"source_id": created["id"]})

    # Assert
    assert res.status_code == 409
    get_settings.cache_clear()


def test_test_endpoint_rejects_unsupported_engine_combo_cleanly(client, monkeypatch, migrated_engine):
    # Arrange: direct 소스는 postgres/sqlite만 API로 만들 수 있지만, direct + mssql
    # 조합은 DB를 직접 편집하면 여전히 도달 가능하다 (리뷰 M3). get_sa_engine이
    # UnsupportedSource를 올리는데 그게 예전엔 except 튜플 밖이라 500이 났다
    from datetime import UTC, datetime

    from sqlalchemy.orm import sessionmaker

    from app.models import DataSource

    _configure(monkeypatch)
    now = datetime.now(UTC)
    with sessionmaker(bind=migrated_engine)() as db:
        source = DataSource(name="weird-combo", engine="mssql", access_mode="direct",
                            is_enabled=True, is_managed=False,
                            created_at=now, updated_at=now)
        db.add(source)
        db.commit()
        sid = source.id

    # Act
    res = client.post(f"/api/sources/{sid}/test", headers=HEADERS)

    # Assert: 500이 아니라 명확한 400
    assert res.status_code == 400
    get_settings.cache_clear()


def test_test_endpoint_records_last_error_when_key_missing(client, monkeypatch):
    # Arrange: 소스는 키가 있을 때 비밀번호와 함께 만들고, 그 뒤 키를 빼고 테스트한다
    # (리뷰 M4) — CryptoNotConfigured 분기가 last_error를 안 건드리면 키를 돌린 뒤에도
    # 목록이 낡은 "정상" 상태를 계속 보여준다
    _configure(monkeypatch)
    created = client.post("/api/sources", headers=HEADERS, json={
        "name": "svcv", "engine": "postgres", "host": "h", "port": 5432,
        "database": "d", "username": "u", "password": "p"}).json()
    monkeypatch.setenv("SOURCE_SECRET_KEY", "")
    get_settings.cache_clear()

    # Act
    res = client.post(f"/api/sources/{created['id']}/test", headers=HEADERS)

    # Assert
    assert res.status_code == 503
    listed = client.get("/api/sources", headers=HEADERS).json()["items"]
    entry = next(item for item in listed if item["id"] == created["id"])
    assert entry["last_error"] == "CryptoNotConfigured"
    get_settings.cache_clear()


def test_duplicate_name_is_a_conflict_not_a_500(client, monkeypatch):
    """PK·이름 UNIQUE 충돌은 409 + 안내 문구로 나온다 — 맨 500은 재시도밖에 못 하게 한다.

    운영에서 이 경로에 도달하는 두 가지: 같은 이름 재등록, 그리고 PostgreSQL에서
    시퀀스가 시드 행(id=1) 뒤로 전진하지 않은 상태의 첫 등록(마이그레이션 0015의 setval).
    """
    # Arrange
    _configure(monkeypatch)
    body = {"name": "svca", "engine": "sqlite", "file_path": "/tmp/a.db"}
    assert client.post("/api/sources", headers=HEADERS, json=body).status_code == 200

    # Act
    res = client.post("/api/sources", headers=HEADERS, json=body)

    # Assert: 드라이버 원문은 응답에 없다 — 종류(error_type)까지만
    assert res.status_code == 409
    assert "conflicts with an existing row" in res.json()["error"]["message"]
    assert "UNIQUE constraint" not in res.text
    get_settings.cache_clear()


def test_source_options_are_readable_by_a_non_sysadmin_without_connection_details(
    client, migrated_engine, monkeypatch
):
    """일반 사용자도 소스를 고를 수 있어야 한다 — 접속정보는 한 필드도 안 나간다.

    스펙 비목표: 소스별 사용자 권한 분리는 하지 않는다(앱에 들어온 사람은 등록된 모든
    소스를 본다). 관리용 목록만 있던 동안에는 일반 사용자가 403 → 빈 목록 → 선택기 숨김이라
    멀티 소스 기능 자체가 관리자에게만 보였다.
    """
    # Arrange: 접속정보가 채워진 소스 1건 + 화이트리스트 일반 사용자(비 sysadmin)
    from app import auth as auth_module
    from app.models import DataSource, LoginWhitelist

    now = datetime.now(UTC)
    with sessionmaker(bind=migrated_engine)() as db:
        db.add(DataSource(name="svca", engine="postgres", access_mode="direct",
                          host="svca-db", port=5432, database="app",
                          username="viewer", password_enc="gAAAA-ciphertext",
                          is_enabled=True, is_managed=False,
                          created_at=now, updated_at=now))
        db.add(LoginWhitelist(login_id="hong.gil", note=None, added_by="admin.sys",
                              created_at=now))
        db.commit()
    settings = get_settings()
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "dbv_sysadmins", "admin.sys")
    client.app.dependency_overrides[auth_module.get_current_user] = lambda: "hong.gil"

    # Act
    options = client.get("/api/sources/options")
    admin_list = client.get("/api/sources")

    # Assert
    assert options.status_code == 200
    assert {item["name"] for item in options.json()["items"]} == {"사내 MSSQL", "svca"}
    assert all(set(item) == {"id", "name", "engine", "is_enabled"}
               for item in options.json()["items"])
    for secret in ("svca-db", "viewer", "gAAAA-ciphertext", "5432"):
        assert secret not in options.text
    # 관리용 전체 목록은 여전히 sysadmin 전용
    assert admin_list.status_code == 403
