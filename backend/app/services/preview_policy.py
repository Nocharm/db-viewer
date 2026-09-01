"""Preview allowlist lookups. / 미리보기 허용 여부 조회.

정책은 한 줄이다: **그 소스에서 허용 목록에 오른 스키마의 객체만 미리보기가 열린다.**
목록이 비어 있으면 전부 차단 — 설정을 잊은 배포가 값 데이터를 여는 쪽으로 기울지 않게 한다.
소스가 키의 일부인 이유: 'public' 같은 흔한 스키마명이 여러 소스에 동시에 존재한다.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import PreviewAllowlist


def list_allowed_schemas(db: Session, source_id: int) -> list[str]:
    return list(db.execute(
        select(PreviewAllowlist.schema)
        .where(PreviewAllowlist.data_source_id == source_id)
        .order_by(PreviewAllowlist.schema)
    ).scalars())


def is_preview_allowed(db: Session, source_id: int, schema: str) -> bool:
    return db.get(PreviewAllowlist, (source_id, schema)) is not None
