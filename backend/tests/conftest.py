"""Shared test fixtures. / 공용 테스트 픽스처."""

import json
import sys
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent
sys.path.insert(0, str(REPO_ROOT / "tools"))


def apply_migrations(url: str) -> None:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)
    command.upgrade(cfg, "head")


@pytest.fixture()
def migrated_engine(tmp_path):
    # Arrange: 마이그레이션 적용된 임시 SQLite / fresh SQLite with all migrations applied
    url = f"sqlite:///{tmp_path / 'test.db'}"
    apply_migrations(url)
    # TestClient는 워커 스레드에서 커넥션을 쓴다 / TestClient uses worker threads
    engine = sa.create_engine(url, connect_args={"check_same_thread": False})
    yield engine
    engine.dispose()


@pytest.fixture()
def fk_conn(migrated_engine):
    # SQLite는 FK 강제가 기본 꺼짐 — 테스트에서만 명시적으로 켠다
    # SQLite disables FK enforcement by default; enable per-connection for tests
    conn = migrated_engine.connect()
    conn.exec_driver_sql("PRAGMA foreign_keys=ON")
    yield conn
    conn.close()


@pytest.fixture()
def client(migrated_engine):
    """TestClient with the DB dependency bound to the migrated engine. / DB 의존성 오버라이드된 클라이언트."""
    from app.db import get_db
    from app.main import create_app

    session_factory = sessionmaker(bind=migrated_engine)

    def override_get_db():
        db = session_factory()
        db.execute(sa.text("PRAGMA foreign_keys=ON"))
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    app = create_app()
    app.dependency_overrides[get_db] = override_get_db
    return TestClient(app)


@pytest.fixture(scope="session")
def fixture_dir(tmp_path_factory):
    """One generated fixture set per test session. / 세션당 픽스처 1세트."""
    import fixture_gen

    out = tmp_path_factory.mktemp("fixture_set")
    fixture_gen.generate(seed=42, out_dir=out)
    return out


@pytest.fixture(scope="session")
def load_fixture(fixture_dir):
    def load(name: str) -> dict:
        return json.loads((fixture_dir / name).read_text())

    return load
