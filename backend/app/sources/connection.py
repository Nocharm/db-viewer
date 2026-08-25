"""Per-source SQLAlchemy engines. / 소스별 엔진 캐시.

요청마다 새 연결을 여는 것보다 작은 풀을 유지하는 편이 싸다. 소스 설정이 바뀌면
캐시를 비워야 낡은 접속정보로 계속 붙지 않는다.
"""

from sqlalchemy import Engine, create_engine

from app.config import get_settings
from app.models import DataSource
from app.sources.registry import build_sa_url

_engines: dict[int, Engine] = {}


def get_sa_engine(source: DataSource) -> Engine:
    """소스의 엔진을 가져오거나, 없으면 생성·캐시 / get cached engine or create new one."""
    cached = _engines.get(source.id)
    if cached is not None:
        return cached
    settings = get_settings()
    kwargs: dict = {"pool_pre_ping": True}
    if source.engine == "postgres":
        # 한 소스가 멎어도 요청이 무한정 붙잡히지 않게 연결·문장 양쪽에 상한을 건다
        kwargs["pool_size"] = 2
        kwargs["max_overflow"] = 1
        kwargs["connect_args"] = {
            "connect_timeout": settings.source_connect_timeout,
            "options": f"-c statement_timeout={settings.source_query_timeout * 1000}",
        }
    else:
        kwargs["connect_args"] = {"timeout": settings.source_connect_timeout,
                                  "check_same_thread": False}
    engine = create_engine(build_sa_url(source), **kwargs)
    _engines[source.id] = engine
    return engine


def clear_sa_engine(source_id: int) -> None:
    """소스 수정·삭제 후 호출 — 낡은 접속정보로 붓는 걸 막는다 / clear stale connection cache."""
    engine = _engines.pop(source_id, None)
    if engine is not None:
        engine.dispose()
