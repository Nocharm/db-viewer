"""Current-user endpoint with login-time AD sync. / 현재 사용자 + 로그인 시 단건 동기화 (bpm 패턴)."""

import logging
import time
from datetime import UTC, datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import get_current_user, is_sysadmin
from app.config import get_settings
from app.db import get_db
from app.models import AppUser, AuditLog, LoginWhitelist

# 로그인 기록의 하루 경계 — KST 자정 (bpm 패턴) / daily dedupe boundary in KST
_KST = timezone(timedelta(hours=9))

logger = logging.getLogger(__name__)

router = APIRouter(tags=["me"])

# 사용자별 동기화 스로틀 — /api/me 반복 호출로 AD를 두들기지 못하게 (보안 리뷰)
# per-user sync throttle so /api/me cannot storm the AD server
_last_sync_at: dict[str, float] = {}


def _record_login(db: Session, login_id: str) -> None:
    """로그인 기록 — KST 기준 하루 1건 중복 제거 (bpm 패턴) / one audit row per day."""
    now = datetime.now(UTC)
    kst_midnight = now.astimezone(_KST).replace(hour=0, minute=0, second=0, microsecond=0)
    today_start = kst_midnight.astimezone(UTC)
    existing = db.execute(
        select(AuditLog.id).where(
            AuditLog.action == "login",
            AuditLog.detail == login_id,
            AuditLog.requested_at >= today_start,
        ).limit(1)
    ).first()
    if existing is None:
        db.add(AuditLog(action="login", detail=login_id,
                        requested_by=login_id, requested_at=now))


@router.get("/api/me")
def get_me(
    login_id: str = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    settings = get_settings()
    sysadmin = is_sysadmin(login_id)
    whitelisted = (
        not settings.auth_enabled
        or sysadmin
        or db.get(LoginWhitelist, login_id) is not None
    )

    # 로그인 시 단건 AD 동기화 — 실패해도 로그인은 막지 않는다 / never block login on sync
    now = time.monotonic()
    due = now - _last_sync_at.get(login_id, 0.0) >= settings.ldap_sync_min_interval
    if settings.auth_enabled and settings.ldap_enabled and whitelisted and due:
        _last_sync_at[login_id] = now
        from app.ad import service as ad_service

        try:
            ad_service.sync_one(db, login_id)
        except Exception:  # LDAP 장애 격리 / isolate LDAP outages
            logger.exception("login-time AD sync failed for %s", login_id)

    _record_login(db, login_id)

    user = db.get(AppUser, login_id)
    return {
        "login_id": login_id,
        "name": user.name if user else login_id,
        "department": user.department if user else None,
        "whitelisted": whitelisted,
        "is_sysadmin": sysadmin,
        "auth_enabled": settings.auth_enabled,
    }
