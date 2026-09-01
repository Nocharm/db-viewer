"""소스 → 접속 URL 조립. / building a connection URL from a source row."""

import time
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from unittest.mock import patch

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import create_engine

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


def test_concurrent_first_touch_creates_engine_once():
    """락이 없으면 경쟁 시 엔진을 N번 생성하는 버그를 잡는다.

    GIL 때문에 sqlite create_engine이 블로킹 없이 끝나므로 스레드가 겹치지 않는다.
    따라서:
    1. create_engine을 패치해서 sleep(0.05)를 넣어 GIL을 양보시킨다.
    2. threading.Barrier로 5개 스레드를 동시에 출발시킨다.
    3. create_engine 호출 횟수를 단언한다 — 1회만 호출되어야 한다.
       (락이 없으면 5회 호출, 각각 다른 엔진 생성 → 버그)
    """
    # Arrange
    clear_sa_engine(999)
    source = _source(id=999, engine="sqlite", file_path="/tmp/test_concurrent.db")
    barrier = threading.Barrier(5)
    call_count = {"value": 0}

    def patched_create_engine(*args, **kwargs):
        # sleep을 넣어 GIL을 양보 — 다른 스레드의 임계구역 진입을 허락
        time.sleep(0.05)
        call_count["value"] += 1
        # 원본 create_engine 호출
        return create_engine(*args, **kwargs)

    def get_engine_with_barrier():
        # 5개 스레드를 모두 도착시킨 후 동시에 출발
        barrier.wait()
        return get_sa_engine(source)

    # Act: create_engine 패치 + 5개 스레드 동시 경쟁
    with patch("app.sources.connection.create_engine", side_effect=patched_create_engine):
        with ThreadPoolExecutor(max_workers=5) as executor:
            engines = list(executor.map(lambda _: get_engine_with_barrier(), range(5)))

    # Assert: create_engine은 정확히 1회만 호출되어야 한다
    assert call_count["value"] == 1, \
        f"engine should be created exactly once, but was called {call_count['value']} times"

    # Assert: 모든 스레드가 같은 엔진 인스턴스를 받아야 한다
    assert all(engine is engines[0] for engine in engines), \
        "all concurrent threads should receive identical engine instance"

    # Cleanup
    clear_sa_engine(999)
