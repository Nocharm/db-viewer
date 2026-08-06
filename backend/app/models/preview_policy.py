"""Preview allowlist — which tables may expose real rows. / 미리보기 허용 테이블 목록.

미리보기는 유일하게 **값 데이터**를 화면에 내보내는 경로라, 어떤 테이블이 열려 있는지가
곧 데이터 노출 범위다. 기본은 전부 차단이고, 이 표에 있는 객체만 열린다.
스냅샷이 아니라 qname(schema.name)을 키로 쓴다 — 재수집해도 허용이 살아남아야 한다
(schema_categories와 같은 이유).
"""

from datetime import datetime

from sqlalchemy import DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.catalog import Base


class PreviewAllowlist(Base):
    """미리보기가 허용된 객체 1건 (없으면 차단). / one allowed object; absence means denied."""

    __tablename__ = "preview_allowlist"

    # "schema.name" — 스키마 128 + 이름 128 + 구분점을 담는 길이
    qname: Mapped[str] = mapped_column(String(257), primary_key=True)
    note: Mapped[str | None] = mapped_column(String(300), nullable=True)
    added_by: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
