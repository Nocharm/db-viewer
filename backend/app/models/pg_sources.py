"""Registered business-Postgres connections. / 등록된 업무 Postgres 연결.

연결을 환경변수가 아니라 표에 두는 이유: 서비스마다 자기 Postgres를 갖고 있어 대상이
계속 늘고 바뀌는데, 그때마다 배포(.env 수정 + 재기동)를 도는 건 운영이 감당하지 못한다.
비밀번호는 평문으로 두지 않는다 — `PG_SOURCE_SECRET`으로 암호화해 넣고, 화면·API로는
절대 되돌려주지 않는다(쓰기 전용 필드).
"""

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.catalog import Base


class PgSource(Base):
    """업무 Postgres 연결 1건. / one registered connection."""

    __tablename__ = "pg_sources"

    # URL 파라미터·미리보기 허용 키(`pg:<slug>:<schema>`)에 쓰는 식별자 — 소문자·숫자·-·_
    slug: Mapped[str] = mapped_column(String(40), primary_key=True)
    label: Mapped[str] = mapped_column(String(100))
    host: Mapped[str] = mapped_column(String(200))
    port: Mapped[int] = mapped_column(Integer)
    database: Mapped[str] = mapped_column(String(128))
    username: Mapped[str] = mapped_column(String(128))
    # Fernet 암호문 — 복호화 키는 .env에만 있다 / ciphertext; the key lives only in .env
    password_enc: Mapped[str] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(String(300), nullable=True)
    created_by: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
