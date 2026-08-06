"""Sysadmin console — whitelist and user sync. / 화이트리스트 관리·AD 전체 동기화 (sysadmin 전용)."""

import time
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.auth import require_preview_admin, require_sysadmin
from app.config import get_settings
from app.db import get_db
from app.models import (
    FLAG_RENDER_HIDDEN_SCHEMAS,
    AppFlag,
    AppUser,
    AuditLog,
    CatalogObject,
    LoginWhitelist,
    PreviewAllowlist,
)
from app.services.schema_visibility import get_hidden_schemas, should_render_hidden_schemas

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


# 한 번에 내려보내는 사용자 수 — 무한 스크롤 페이지 크기 / page size for the AD user list
USER_PAGE_SIZE = 100


@router.get("/users")
def list_users(
    q: str = "", offset: int = 0, limit: int = USER_PAGE_SIZE,
    db: Session = Depends(get_db),
) -> dict:
    """AD 동기 사용자 목록 — 검색은 전체 집합 대상, 결과는 페이지 단위로 내려준다.

    수천 명 규모의 AD를 화면이 다 들고 있을 수 없어 검색을 DB로 내린다
    (클라이언트 필터는 이미 로드된 분량만 훑게 되어 "안 나온다"가 된다).
    Search runs in the DB so it covers everyone, not just the loaded page.
    """
    limit = min(max(limit, 1), 500)
    offset = max(offset, 0)
    conditions = []
    term = q.strip()
    if term:
        pattern = f"%{term}%"
        conditions.append(or_(
            AppUser.login_id.ilike(pattern),
            AppUser.name.ilike(pattern),
            AppUser.department.ilike(pattern),
        ))
    total = db.execute(
        select(func.count()).select_from(AppUser).where(*conditions)).scalar_one()
    users = db.execute(
        select(AppUser).where(*conditions)
        .order_by(AppUser.login_id).offset(offset).limit(limit)
    ).scalars().all()
    return {
        "items": [
            {"login_id": u.login_id, "name": u.name, "department": u.department,
             "email": u.email, "active": u.active, "source": u.source, "role": u.role}
            for u in users
        ],
        "total": total,
        "has_more": offset + len(users) < total,
    }


@router.get("/preview-allowlist")
def list_preview_allowlist(db: Session = Depends(get_db)) -> dict:
    """허용 스키마 + 등록 정보 — 읽기는 관리자 게이트만, 수정만 비밀번호를 요구한다."""
    rows = db.execute(
        select(PreviewAllowlist).order_by(PreviewAllowlist.schema)
    ).scalars().all()
    return {
        "password_configured": bool(get_settings().preview_admin_password),
        "items": [
            {"schema": row.schema, "note": row.note, "added_by": row.added_by,
             "created_at": row.created_at.isoformat()}
            for row in rows
        ],
    }


class PreviewAllowRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    # 'schema'는 BaseModel 예약 이름과 충돌해 alias 사용 (RawObject와 같은 관용).
    # pydantic이 FastAPI 본문 모델에 UnsupportedFieldAttributeWarning을 내지만
    # alias 자체는 동작한다 (test_preview_allowlist가 {"schema": …}로 검증)
    schema_name: str = Field(alias="schema")
    note: str | None = None


@router.post("/preview-allowlist", dependencies=[Depends(require_preview_admin)])
def add_preview_allow(
    req: PreviewAllowRequest,
    db: Session = Depends(get_db),
    admin: str = Depends(require_sysadmin),
) -> dict:
    """스키마 하나를 미리보기 허용으로 등록 — 그 스키마의 모든 객체가 열린다."""
    schema = req.schema_name.strip()
    # 오타로 유령 허용이 쌓이면 목록만 늘고 아무 테이블도 안 열린다 (schema_categories 동일 관용)
    exists = db.execute(
        select(CatalogObject.id).where(CatalogObject.schema == schema).limit(1)
    ).scalar_one_or_none()
    if exists is None:
        raise HTTPException(400, {"message": "unknown schema in the catalog",
                                  "context": {"schema": schema}})

    now = datetime.now(UTC)
    row = db.get(PreviewAllowlist, schema)
    if row is None:
        db.add(PreviewAllowlist(schema=schema, note=req.note, added_by=admin,
                                created_at=now))
    else:
        row.note = req.note
    db.add(AuditLog(action="preview_allow_add", detail=schema,
                    requested_by=admin, requested_at=now))
    return {"schema": schema, "created": row is None}


@router.get("/audit")
def get_audit_log(
    action: str | None = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    _admin: str = Depends(require_sysadmin),
) -> dict:
    """감사 로그 조회 — 최신순. 노출·권한을 바꾼 조작이 언제 누구에 의해 있었는지 본다.

    허용 목록 등록/해제, 감춤 표시 토글, 로그인 화이트리스트 변경, 실값 반출(미리보기·
    조인 샘플)이 모두 같은 표에 쌓인다. `total`을 함께 주는 건 잘린 목록만 보면 화면이
    "이게 전부"라고 거짓말하기 때문 (objects 검색과 같은 이유).
    """
    filters = [AuditLog.action == action] if action else []
    total = db.execute(
        select(func.count()).select_from(AuditLog).where(*filters)
    ).scalar_one()
    rows = db.execute(
        select(AuditLog).where(*filters)
        .order_by(AuditLog.requested_at.desc(), AuditLog.id.desc())
        .limit(limit).offset(offset)
    ).scalars().all()
    # 필터 드롭다운을 채우려면 어떤 action이 실제로 쌓였는지 알아야 한다
    actions = list(db.execute(
        select(AuditLog.action).distinct().order_by(AuditLog.action)
    ).scalars())
    return {
        "total": total,
        "actions": actions,
        "items": [
            {
                "id": row.id, "action": row.action, "detail": row.detail,
                "requested_by": row.requested_by,
                "requested_at": row.requested_at.isoformat(),
            }
            for row in rows
        ],
    }


@router.get("/hidden-schema-render")
def get_hidden_schema_render(db: Session = Depends(get_db)) -> dict:
    """감춘 스키마의 목록 렌더 토글 상태 + 대상 스키마(읽기 전용).

    `schemas`는 `HIDDEN_SCHEMAS` 환경변수가 원본이라 이 API로는 못 바꾼다 — 무엇을
    감출지는 배포 권한의 영역이고, 여기서는 목록에 보일지만 켜고 끈다.
    """
    return {
        "render": should_render_hidden_schemas(db),
        "schemas": sorted(get_hidden_schemas()),
    }


class HiddenSchemaRenderRequest(BaseModel):
    render: bool


@router.put("/hidden-schema-render", dependencies=[Depends(require_preview_admin)])
def set_hidden_schema_render(
    req: HiddenSchemaRenderRequest,
    db: Session = Depends(get_db),
    admin: str = Depends(require_sysadmin),
) -> dict:
    """토글 변경 — 미리보기 허용 목록과 같은 비밀번호 게이트를 쓴다.

    켜는 쪽이 노출을 넓히는 방향이라(감춘 스키마 이름이 좌측 목록에 다시 나타난다)
    허용 목록 수정과 같은 부류로 본다.
    """
    now = datetime.now(UTC)
    row = db.get(AppFlag, FLAG_RENDER_HIDDEN_SCHEMAS)
    if row is None:
        db.add(AppFlag(key=FLAG_RENDER_HIDDEN_SCHEMAS, value=req.render,
                       updated_by=admin, updated_at=now))
    else:
        row.value = req.render
        row.updated_by = admin
        row.updated_at = now
    db.add(AuditLog(action="hidden_schema_render_set", detail=str(req.render).lower(),
                    requested_by=admin, requested_at=now))
    return {"render": req.render}


@router.delete("/preview-allowlist/{schema}",
               dependencies=[Depends(require_preview_admin)])
def remove_preview_allow(
    schema: str,
    db: Session = Depends(get_db),
    admin: str = Depends(require_sysadmin),
) -> dict:
    row = db.get(PreviewAllowlist, schema)
    if row is None:
        raise HTTPException(404, {"message": "not in the preview allowlist",
                                  "context": {"schema": schema}})
    db.delete(row)
    db.add(AuditLog(action="preview_allow_remove", detail=schema,
                    requested_by=admin, requested_at=datetime.now(UTC)))
    return {"schema": schema, "removed": True}


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
