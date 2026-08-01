"""Sysadmin console — whitelist and user sync. / 화이트리스트 관리·AD 전체 동기화 (sysadmin 전용)."""

import time
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import require_sysadmin
from app.config import get_settings
from app.db import get_db
from app.models import AppUser, AuditLog, LoginWhitelist

router = APIRouter(
    prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_sysadmin)]
)

# 전체 동기화 스로틀 — 5분 (bpm 동일) / in-process full-sync throttle
_FULL_SYNC_MIN_INTERVAL = 300.0
_last_full_sync = 0.0


@router.get("/whitelist")
def list_whitelist(db: Session = Depends(get_db)) -> dict:
    rows = db.execute(
        select(LoginWhitelist, AppUser.name)
        .outerjoin(AppUser, AppUser.login_id == LoginWhitelist.login_id)
        .order_by(LoginWhitelist.login_id)
    ).all()
    return {"items": [
        {"login_id": w.login_id, "name": name, "note": w.note,
         "added_by": w.added_by, "created_at": w.created_at.isoformat()}
        for w, name in rows
    ]}


class WhitelistAddRequest(BaseModel):
    login_id: str
    note: str | None = None


@router.post("/whitelist")
def add_whitelist(
    req: WhitelistAddRequest,
    db: Session = Depends(get_db),
    admin: str = Depends(require_sysadmin),
) -> dict:
    login_id = req.login_id.strip()
    if not login_id:
        raise HTTPException(400, {"message": "login_id is required"})
    now = datetime.now(UTC)
    existing = db.get(LoginWhitelist, login_id)
    if existing is None:
        db.add(LoginWhitelist(login_id=login_id, note=req.note, added_by=admin, created_at=now))
    else:
        existing.note = req.note
    db.add(AuditLog(action="whitelist_add", detail=login_id,
                    requested_by=admin, requested_at=now))
    return {"login_id": login_id, "created": existing is None}


@router.delete("/whitelist/{login_id}")
def remove_whitelist(
    login_id: str,
    db: Session = Depends(get_db),
    admin: str = Depends(require_sysadmin),
) -> dict:
    row = db.get(LoginWhitelist, login_id)
    if row is None:
        raise HTTPException(404, {"message": "not in whitelist",
                                  "context": {"login_id": login_id}})
    db.delete(row)
    db.add(AuditLog(action="whitelist_remove", detail=login_id,
                    requested_by=admin, requested_at=datetime.now(UTC)))
    return {"login_id": login_id, "removed": True}


@router.get("/users")
def list_users(db: Session = Depends(get_db)) -> dict:
    users = db.execute(select(AppUser).order_by(AppUser.login_id).limit(500)).scalars().all()
    return {"items": [
        {"login_id": u.login_id, "name": u.name, "department": u.department,
         "email": u.email, "active": u.active, "source": u.source, "role": u.role}
        for u in users
    ]}


@router.post("/users/sync")
def sync_users(db: Session = Depends(get_db)) -> dict:
    """AD 전체 동기화 — 5분 스로틀, LDAP 미설정 시 503 / throttled full sync."""
    global _last_full_sync
    if not get_settings().ldap_enabled:
        raise HTTPException(503, {"message": "LDAP is not configured"})
    now = time.monotonic()
    if now - _last_full_sync < _FULL_SYNC_MIN_INTERVAL:
        raise HTTPException(429, {"message": "full sync ran recently — try again later"})
    _last_full_sync = now

    from app.ad import service as ad_service

    summary = ad_service.sync_all(db)
    return {"scanned": summary.scanned, "upserted": summary.upserted,
            "excluded": summary.excluded, "purged": summary.purged}
