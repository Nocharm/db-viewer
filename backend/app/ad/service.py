"""AD sync orchestration — upsert and stale prune. / AD 동기화 오케스트레이션 (bpm 패턴)."""

from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.ad import client
from app.ad.org import RawUser, to_user_fields
from app.config import get_settings
from app.models import AppUser


@dataclass(frozen=True)
class SyncSummary:
    scanned: int
    upserted: int
    excluded: int
    purged: int


def _upsert(db: Session, fields: dict, now: datetime) -> None:
    user = db.get(AppUser, fields["login_id"])
    if user is None:
        db.add(AppUser(**fields, created_at=now, updated_at=now))
    else:
        for key, value in fields.items():
            setattr(user, key, value)
        user.updated_at = now


def sync_one(db: Session, login_id: str) -> bool:
    """로그인 시 단건 동기화 — 실패해도 로그인은 막지 않는다 / login-time single sync."""
    raw = client.fetch_user(login_id)
    if raw is None:
        return False
    fields = to_user_fields(raw, get_settings().sysadmin_login_ids())
    if fields is None:
        return False
    _upsert(db, fields, datetime.now(UTC))
    return True


def sync_all(db: Session, raws: list[RawUser] | None = None) -> SyncSummary:
    """전체 동기화 + 퇴사자 정리 — source='local'은 보존 / full sync with stale prune."""
    raw_users: list[RawUser] = client.fetch_all_users() if raws is None else raws
    sysadmins = get_settings().sysadmin_login_ids()
    now = datetime.now(UTC)

    valid_ids: set[str] = set()
    upserted = excluded = 0
    for raw in raw_users:
        fields = to_user_fields(raw, sysadmins)
        if fields is None:
            excluded += 1
            continue
        _upsert(db, fields, now)
        valid_ids.add(fields["login_id"])
        upserted += 1

    purged = 0
    if valid_ids:  # 빈 스캔·전원 제외 시 전삭제 방지 / never wipe on an empty scan
        stale = db.execute(
            select(AppUser.login_id).where(
                AppUser.source == "ad", AppUser.login_id.not_in(list(valid_ids))
            )
        ).scalars().all()
        if stale:
            db.execute(delete(AppUser).where(AppUser.login_id.in_(stale)))
            purged = len(stale)

    return SyncSummary(len(raw_users), upserted, excluded, purged)
