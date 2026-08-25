"""Schema→business category mapping. / 스키마(DB)별 업무 카테고리 매핑.

실 스키마가 ATM·BCMS·SAP… 처럼 DB 단위라 분류 단위도 스키마다. 매핑 행이 없으면
카테고리는 스키마명 자체 — 설정 전에도 목록이 비지 않는다. 스냅샷에 종속되지 않게
스키마명(텍스트)을 키로 쓴다: 재수집해도 매핑이 살아남아야 한다.
"""

from datetime import datetime

from sqlalchemy import DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.catalog import Base


class SchemaCategory(Base):
    """사용자가 지정한 스키마→카테고리 (미지정 스키마는 행이 없다). / explicit mappings only."""

    __tablename__ = "schema_categories"

    # 같은 스키마명이 여러 소스에 존재한다 — 소스가 PK의 일부여야 매핑이 섞이지 않는다
    data_source_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    schema_name: Mapped[str] = mapped_column(String(128), primary_key=True)
    category: Mapped[str] = mapped_column(String(100))
    updated_by: Mapped[str] = mapped_column(String(100))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
