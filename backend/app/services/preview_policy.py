"""Preview allowlist lookups. / 미리보기 허용 여부 조회.

정책은 한 줄이다: **허용 목록에 있는 스키마의 객체만 미리보기가 열린다.** 목록이 비어
있으면 전부 차단 — 설정을 잊은 배포가 값 데이터를 여는 쪽으로 기울지 않게 하는 기본값이다.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import PreviewAllowlist


def list_allowed_schemas(db: Session) -> list[str]:
    return list(db.execute(
        select(PreviewAllowlist.schema).order_by(PreviewAllowlist.schema)
    ).scalars())


def is_preview_allowed(db: Session, schema: str) -> bool:
    return db.get(PreviewAllowlist, schema) is not None
