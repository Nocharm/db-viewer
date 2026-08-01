"""Service-DB engine and session factory. / 서비스 DB 엔진·세션 팩토리."""

from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings

_engine = None
_session_factory: sessionmaker | None = None


def get_session_factory() -> sessionmaker:
    """Create the engine lazily on first use. / 첫 사용 시점에 엔진 생성."""
    global _engine, _session_factory
    if _session_factory is None:
        _engine = create_engine(get_settings().database_url, pool_pre_ping=True)
        _session_factory = sessionmaker(bind=_engine)
    return _session_factory


def get_db() -> Iterator[Session]:
    """FastAPI dependency — commit on success, rollback on error. / 성공 시 커밋, 실패 시 롤백."""
    db = get_session_factory()()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
