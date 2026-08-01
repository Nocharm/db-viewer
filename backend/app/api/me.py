"""Current-user endpoint with login-time AD sync. / 현재 사용자 + 로그인 시 단건 동기화 (bpm 패턴)."""

import logging

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth import get_current_user, is_sysadmin
from app.config import get_settings
from app.db import get_db
from app.models import AppUser, LoginWhitelist

logger = logging.getLogger(__name__)

router = APIRouter(tags=["me"])


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
    if settings.auth_enabled and settings.ldap_enabled and whitelisted:
        from app.ad import service as ad_service

        try:
            ad_service.sync_one(db, login_id)
        except Exception:  # LDAP 장애 격리 / isolate LDAP outages
            logger.exception("login-time AD sync failed for %s", login_id)

    user = db.get(AppUser, login_id)
    return {
        "login_id": login_id,
        "name": user.name if user else login_id,
        "department": user.department if user else None,
        "whitelisted": whitelisted,
        "is_sysadmin": sysadmin,
        "auth_enabled": settings.auth_enabled,
    }
