"""소스 → 접속 URL 조립. / building a connection URL from a source row."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

import pytest
from cryptography.fernet import Fernet

from app.config import get_settings
from app.models import DataSource
from app.sources.connection import clear_sa_engine, get_sa_engine
from app.sources.crypto import encrypt_secret
from app.sources.registry import UnsupportedSource, build_sa_url


@pytest.fixture()
def configured_key(monkeypatch):
    monkeypatch.setenv("SOURCE_SECRET_KEY", Fernet.generate_key().decode())
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _source(**kw) -> DataSource:
    now = datetime.now(UTC)
    base = dict(name="s", access_mode="direct", is_enabled=True, is_managed=False,
                created_at=now, updated_at=now)
    return DataSource(**{**base, **kw})


def test_builds_postgres_url_with_decrypted_password(configured_key):
    # Arrange
    source = _source(engine="postgres", host="svca-db", port=5432,
                     database="app", username="viewer",
                     password_enc=encrypt_secret("p@ss/word"))

    # Act
    url = build_sa_url(source)

    # Assert: 특수문자가 URL 인코딩되어야 파싱이 깨지지 않는다
    assert url == "postgresql+psycopg://viewer:p%40ss%2Fword@svca-db:5432/app"


def test_builds_sqlite_readonly_uri():
    # Arrange
    source = _source(engine="sqlite", file_path="/mnt/sources/svcc/app.db")

    # Act
    url = build_sa_url(source)

    # Assert: 읽기전용으로만 연다 — 볼륨 :ro와 이중으로 막는다
    assert url == "sqlite:///file:/mnt/sources/svcc/app.db?mode=ro&uri=true"


def test_rejects_n8n_source():
    # Arrange: n8n 소스는 백엔드가 직접 붙지 않는다
    source = _source(engine="mssql", access_mode="n8n")

    # Act / Assert
    with pytest.raises(UnsupportedSource):
        build_sa_url(source)


def test_concurrent_first_touch_returns_same_engine():
    # Arrange: 캐시 초기화 후 SQLite 소스(실제 DB 파일 불필요)
    clear_sa_engine(999)
    source = _source(id=999, engine="sqlite", file_path="/tmp/test_concurrent.db")

    # Act: 5개 스레드가 동시에 같은 소스에서 엔진 요청
    def get_engine_for_source():
        return get_sa_engine(source)

    with ThreadPoolExecutor(max_workers=5) as executor:
        engines = list(executor.map(lambda _: get_engine_for_source(), range(5)))

    # Assert: 모두 같은 엔진 인스턴스를 받아야 함 (id() 비교, 동일성 보장)
    assert all(engine is engines[0] for engine in engines), \
        "Concurrent first-touch should return identical engine instance"

    # Cleanup
    clear_sa_engine(999)
