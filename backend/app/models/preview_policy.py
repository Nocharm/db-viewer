"""Preview allowlist — which schemas may expose real rows. / 미리보기 허용 스키마 목록.

미리보기는 유일하게 **값 데이터**를 화면에 내보내는 경로라, 어떤 스키마가 열려 있는지가
곧 데이터 노출 범위다. 기본은 전부 차단이고, 이 표에 있는 스키마의 객체만 열린다.
스냅샷 id가 아니라 스키마명을 키로 쓴다 — 재수집해도 허용이 살아남아야 한다
(schema_categories와 같은 이유).
"""

from datetime import datetime

from sqlalchemy import DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.catalog import Base


class PreviewAllowlist(Base):
    """미리보기가 허용된 스키마 1건 (없으면 그 스키마 전체 차단). / one allowed schema."""

    __tablename__ = "preview_allowlist"

    # CatalogObject.schema와 같은 길이 / mirrors the catalog column
    schema: Mapped[str] = mapped_column(String(128), primary_key=True)
    note: Mapped[str | None] = mapped_column(String(300), nullable=True)
    added_by: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
