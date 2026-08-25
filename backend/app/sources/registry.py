"""Source lookup and connection-URL assembly. / 소스 조회·접속 URL 조립."""

from urllib.parse import quote

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import DataSource
from app.models.sources import MANAGED_MSSQL_SOURCE_ID
from app.sources.crypto import decrypt_secret


class UnsupportedSource(RuntimeError):
    """직결로 붙을 수 없는 소스 — n8n 경유이거나 알 수 없는 엔진."""


def get_source(db: Session, source_id: int | None) -> DataSource:
    """소스 1건 — 생략하면 기본 소스(사내 MSSQL) / one source, default when omitted."""
    target = source_id if source_id is not None else MANAGED_MSSQL_SOURCE_ID
    source = db.get(DataSource, target)
    if source is None:
        raise HTTPException(404, {"message": "data source not found",
                                  "context": {"source_id": target}})
    return source


def list_sources(db: Session) -> list[DataSource]:
    """모든 활성 소스를 이름순 정렬 / all sources, sorted by managed-status and name."""
    return list(db.execute(
        select(DataSource).order_by(DataSource.is_managed.desc(), DataSource.name)
    ).scalars())


def build_sa_url(source: DataSource) -> str:
    """직결 소스의 SQLAlchemy URL / SQLAlchemy URL for a direct source.

    비밀번호에 `@`나 `/`가 들어가면 URL 파싱이 깨진다 — 사용자·비밀번호는 항상 인코딩한다.
    sqlite는 `mode=ro` URI로 연다: 볼륨 `:ro` 마운트와 이중으로 쓰기를 막는다.
    """
    if source.access_mode != "direct":
        raise UnsupportedSource(
            f"source {source.name!r} is served through n8n, not a direct connection")
    if source.engine == "postgres":
        user = quote(source.username or "", safe="")
        password = quote(decrypt_secret(source.password_enc), safe="") \
            if source.password_enc else ""
        auth = f"{user}:{password}" if password else user
        return f"postgresql+psycopg://{auth}@{source.host}:{source.port}/{source.database}"
    if source.engine == "sqlite":
        return f"sqlite:///file:{source.file_path}?mode=ro&uri=true"
    raise UnsupportedSource(f"unsupported engine: {source.engine}")
