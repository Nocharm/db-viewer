"""App users (AD-synced) and the login whitelist. / AD 동기 사용자·로그인 화이트리스트."""

from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.catalog import Base


class AppUser(Base):
    """AD-synced user profile — login_id == sAMAccountName. / AD 동기 사용자."""

    __tablename__ = "app_users"

    login_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    title: Mapped[str | None] = mapped_column(String(100))
    department: Mapped[str | None] = mapped_column(String(200))
    # OU 경로 root→leaf를 '/'로 연결 / org units joined root-to-leaf
    org_path: Mapped[str | None] = mapped_column(String(600))
    email: Mapped[str | None] = mapped_column(String(200))
    active: Mapped[bool] = mapped_column(Boolean)
    source: Mapped[str] = mapped_column(String(10))  # ad | local
    role: Mapped[str] = mapped_column(String(10))    # admin | user
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("source IN ('ad', 'local')", name="ck_app_users_source"),
        CheckConstraint("role IN ('admin', 'user')", name="ck_app_users_role"),
    )


class LoginWhitelist(Base):
    """로그인 허용 목록 — 게이트는 app.auth.require_whitelisted / login allowlist."""

    __tablename__ = "login_whitelist"

    login_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    note: Mapped[str | None] = mapped_column(String(200))
    added_by: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
