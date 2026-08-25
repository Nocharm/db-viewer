"""Registered data sources. / 조회 대상 DB 소스 등록부.

한 소스 = 한 DB. 스냅샷이 여기에 매달리고, 수집기·미리보기 실행기 선택도 이 행이 정한다.
사내 MSSQL도 소스 1건으로 표현하되 접속정보는 여전히 .env/n8n에 있어 is_managed로 잠근다.
"""

from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.catalog import Base

# 마이그레이션이 시드하는 사내 MSSQL 소스 — 소스 미지정 요청의 기본값
MANAGED_MSSQL_SOURCE_ID = 1


class DataSource(Base):
    """조회 대상 DB 한 곳. / one registered database."""

    __tablename__ = "data_sources"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    engine: Mapped[str] = mapped_column(String(16))
    # n8n = 워크플로 경유(사내 MSSQL) / direct = 백엔드가 직접 접속
    access_mode: Mapped[str] = mapped_column(String(8))

    host: Mapped[str | None] = mapped_column(String(255))
    port: Mapped[int | None] = mapped_column(Integer)
    database: Mapped[str | None] = mapped_column(String(128))
    username: Mapped[str | None] = mapped_column(String(128))
    # Fernet 암호문만 저장 — 평문이 이 컬럼에 들어가는 경로는 없어야 한다
    password_enc: Mapped[str | None] = mapped_column(Text)
    # sqlite 전용 — 컨테이너 내부 경로 / container-side path for sqlite sources
    file_path: Mapped[str | None] = mapped_column(String(500))

    is_enabled: Mapped[bool] = mapped_column(Boolean)
    # true면 .env/n8n이 소유 — API가 수정·삭제를 거부한다
    is_managed: Mapped[bool] = mapped_column(Boolean)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_ok_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        CheckConstraint("engine IN ('mssql', 'postgres', 'sqlite')",
                        name="ck_data_sources_engine"),
        CheckConstraint("access_mode IN ('n8n', 'direct')",
                        name="ck_data_sources_access_mode"),
    )
