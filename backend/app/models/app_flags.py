"""Runtime toggles the admin console owns. / 관리 콘솔이 켜고 끄는 런타임 플래그.

정책 자체가 아니라 **표시 방식**을 담는다. 예를 들어 어떤 스키마의 컬럼을 감출지는
`HIDDEN_SCHEMAS`(환경변수, 배포 권한이 있어야 바꾼다)가 정하고, 그 스키마를 화면
목록에 아예 안 그릴지는 여기 플래그가 정한다 — 운영 중 바꿔야 하는 쪽만 DB에 둔다.
"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.catalog import Base

# 감춘 스키마를 좌측 스키마·카테고리 목록과 테이블 목록에 그릴지 / render hidden schemas in the rails
FLAG_RENDER_HIDDEN_SCHEMAS = "render_hidden_schemas"


class AppFlag(Base):
    """관리 콘솔 토글 1건. 행이 없으면 호출부의 기본값을 쓴다. / one toggle; absent row = default."""

    __tablename__ = "app_flags"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[bool] = mapped_column(Boolean)
    updated_by: Mapped[str] = mapped_column(String(100))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
