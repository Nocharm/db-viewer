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


def get_source(
    db: Session, source_id: int | None, *, allow_disabled: bool = False
) -> DataSource:
    """소스 1건 — 생략하면 기본 소스(사내 MSSQL) / one source, default when omitted.

    비활성 소스는 여기서 막는다 — 미리보기(objects.py)·수집 트리거(collect.py)가 이
    함수를 거쳐 소스를 얻으므로, 한 곳만 지키면 "비활성 소스로 조용히 동작"하는 경로가
    전부 막힌다. 관리 API의 목록·수정·삭제는 이 함수를 쓰지 않는다 — 비활성 소스도
    계속 보이고 다시 켤 수 있어야 하기 때문(관리 API가 이 게이트에 걸리면 다시 켤
    방법이 없어진다).

    `allow_disabled=True`는 연결 테스트(sources.py `/test`) 전용 예외다 — "자격증명을
    고치고 → 테스트로 확인하고 → 재활성화"가 정상 운영 순서인데, 테스트 자체를
    막으면 확인 없이 먼저 켜야 하는 정반대 순서를 강제하게 된다. 라이브 연결이 실제로
    걸리는 미리보기·수집 트리거는 여전히 기본값(False)으로 막힌다.
    """
    target = source_id if source_id is not None else MANAGED_MSSQL_SOURCE_ID
    source = db.get(DataSource, target)
    if source is None:
        raise HTTPException(404, {"message": "data source not found",
                                  "context": {"source_id": target}})
    if not source.is_enabled and not allow_disabled:
        raise HTTPException(409, {
            "message": "this data source is disabled — enable it before connecting",
            "context": {"source_id": source.id, "name": source.name}})
    return source


def list_sources(db: Session) -> list[DataSource]:
    """전부(비활성 포함) 이름순 정렬 / all sources including disabled ones, name-sorted.

    비활성 소스도 빠지면 안 된다 — 관리 콘솔 목록이 이걸 그대로 쓰는데, 여기서 걸러지면
    끈 소스를 다시 켤 방법이 없어진다(get_source의 is_enabled 게이트와 짝을 이루는 대우).
    """
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
