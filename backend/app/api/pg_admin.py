"""Postgres source registry — admin CRUD, connection test, schema unlock.
/ 업무 Postgres 연결 관리 — 등록·수정·삭제·연결 테스트·스키마 허용.

서비스마다 자기 Postgres를 갖고 있어 대상이 계속 늘어난다 — .env 한 줄로는 담지 못해
관리 콘솔에서 목록을 관리한다. 두 겹 잠금은 미리보기 허용 목록과 같다: 시스템관리자
로그인 + `PREVIEW_ADMIN_PASSWORD`. 자격증명을 다루고 값 노출 범위를 바꾸는 조작이라
읽기(목록)까지 관리자 전용이며, 비밀번호는 어떤 응답에도 실리지 않는다.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.adapters import pg_source as pg
from app.auth import require_preview_admin, require_sysadmin
from app.config import get_settings
from app.db import get_db
from app.models import AuditLog, PgSource, PreviewAllowlist
from app.services import pg_sources

router = APIRouter(
    prefix="/api/admin/pg-sources", tags=["pg-admin"],
    dependencies=[Depends(require_sysadmin)],
)

# 편집 게이트 — 등록·수정·삭제·스키마 허용에 공통으로 얹는다 / password gate for every edit
_EDIT_GATE = [Depends(require_preview_admin)]


class SourceCreate(BaseModel):
    slug: str = Field(max_length=40)
    label: str = Field(max_length=100)
    host: str = Field(max_length=200)
    port: int = Field(5432, ge=1, le=65535)
    database: str = Field(max_length=128)
    username: str = Field(max_length=128)
    password: str = Field(max_length=200)
    note: str | None = Field(None, max_length=300)


class SourceUpdate(BaseModel):
    label: str | None = Field(None, max_length=100)
    host: str | None = Field(None, max_length=200)
    port: int | None = Field(None, ge=1, le=65535)
    database: str | None = Field(None, max_length=128)
    username: str | None = Field(None, max_length=128)
    # 생략하면 기존 비밀번호 유지 — 화면은 저장된 값을 되읽을 수 없다
    password: str | None = Field(None, max_length=200)
    note: str | None = Field(None, max_length=300)


class SchemaUnlock(BaseModel):
    schema_name: str = Field(alias="schema", max_length=128)
    allowed: bool
    note: str | None = Field(None, max_length=300)


def _as_dict(db: Session, source: PgSource) -> dict:
    return {
        "slug": source.slug, "label": source.label, "host": source.host,
        "port": source.port, "database": source.database, "username": source.username,
        "note": source.note, "created_by": source.created_by,
        "updated_at": source.updated_at.isoformat(),
        "allowed_schemas": pg_sources.list_allowed_schemas(db, source.slug),
    }


def _require_source(db: Session, slug: str) -> PgSource:
    source = pg_sources.get_source(db, slug)
    if source is None:
        raise HTTPException(404, {"message": "unknown Postgres source",
                                  "context": {"source": slug}})
    return source


def _encrypt(password: str) -> str:
    try:
        return pg_sources.encrypt_password(get_settings(), password)
    except pg_sources.PgSecretMissing as e:
        raise HTTPException(503, {"message": str(e), "context": {}}) from e


@router.get("")
def list_pg_sources(db: Session = Depends(get_db)) -> dict:
    """등록된 연결 — 비밀번호는 제외. 키 미설정이면 화면이 그 사실을 먼저 알린다."""
    return {
        "secret_configured": get_settings().pg_source_enabled,
        "password_configured": bool(get_settings().preview_admin_password),
        "items": [_as_dict(db, s) for s in pg_sources.list_sources(db)],
    }


@router.post("", dependencies=_EDIT_GATE)
def create_pg_source(
    req: SourceCreate, db: Session = Depends(get_db), admin: str = Depends(require_sysadmin),
) -> dict:
    """연결 등록 — slug는 허용 키·URL에 그대로 들어가 형식을 좁게 검증한다."""
    if not pg_sources.SLUG_PATTERN.match(req.slug):
        raise HTTPException(400, {
            "message": "slug must be lowercase letters, digits, '-' or '_' (max 40)",
            "context": {"slug": req.slug}})
    if pg_sources.get_source(db, req.slug) is not None:
        raise HTTPException(409, {"message": "a source with this slug already exists",
                                  "context": {"slug": req.slug}})
    now = datetime.now(UTC)
    db.add(PgSource(
        slug=req.slug, label=req.label, host=req.host, port=req.port,
        database=req.database, username=req.username,
        password_enc=_encrypt(req.password), note=req.note,
        created_by=admin, created_at=now, updated_at=now,
    ))
    db.add(AuditLog(action="pg_source_add",
                    detail=f"{req.slug} ({req.username}@{req.host}:{req.port}/{req.database})",
                    requested_by=admin, requested_at=now))
    return {"slug": req.slug, "created": True}


@router.patch("/{slug}", dependencies=_EDIT_GATE)
def update_pg_source(
    slug: str, req: SourceUpdate, db: Session = Depends(get_db),
    admin: str = Depends(require_sysadmin),
) -> dict:
    """연결 수정 — 준 값만 바꾼다. 비밀번호는 생략하면 그대로 둔다."""
    source = _require_source(db, slug)
    changed = []
    for field in ("label", "host", "port", "database", "username", "note"):
        value = getattr(req, field)
        if value is not None and value != getattr(source, field):
            setattr(source, field, value)
            changed.append(field)
    if req.password:
        source.password_enc = _encrypt(req.password)
        changed.append("password")
    now = datetime.now(UTC)
    source.updated_at = now
    db.add(AuditLog(action="pg_source_update",
                    detail=f"{slug} ({', '.join(changed) or 'no change'})",
                    requested_by=admin, requested_at=now))
    return {"slug": slug, "changed": changed}


@router.delete("/{slug}", dependencies=_EDIT_GATE)
def delete_pg_source(
    slug: str, db: Session = Depends(get_db), admin: str = Depends(require_sysadmin),
) -> dict:
    """연결 삭제 — 그 소스의 허용 행도 함께 지운다(연결 없는 유령 허용 방지)."""
    source = _require_source(db, slug)
    unlocked = pg_sources.list_allowed_schemas(db, slug)
    for schema in unlocked:
        db.delete(db.get(PreviewAllowlist, pg_sources.allowlist_key(slug, schema)))
    db.delete(source)
    now = datetime.now(UTC)
    db.add(AuditLog(action="pg_source_remove",
                    detail=f"{slug} (허용 스키마 {len(unlocked)}건 함께 해제)",
                    requested_by=admin, requested_at=now))
    return {"slug": slug, "removed": True, "unlocked_removed": len(unlocked)}


@router.post("/{slug}/test")
def test_pg_source(slug: str, db: Session = Depends(get_db)) -> dict:
    """연결 테스트 — 등록 직후 "왜 안 보이지"를 화면에서 바로 가른다.

    실패를 예외로 올리지 않고 사유를 담아 200으로 돌려준다: 실패도 이 API의 정상 결과다.
    """
    from app.api.pg_source import resolve_source

    try:
        _, dsn, timeout = resolve_source(db, slug)
        tables = pg.list_tables(dsn, timeout)
    except HTTPException as e:
        detail = e.detail if isinstance(e.detail, dict) else {"message": str(e.detail)}
        return {"ok": False, "error": detail.get("message", "")}
    except pg.PgSourceError as e:
        return {"ok": False, "error": str(e)}
    return {
        "ok": True,
        "schemas": sorted({t["schema"] for t in tables}),
        "table_count": len(tables),
    }


@router.get("/{slug}/schemas")
def list_pg_source_schemas(slug: str, db: Session = Depends(get_db)) -> dict:
    """소스의 스키마 목록 + 허용 여부 — 관리 화면의 토글 목록 데이터."""
    from app.api.pg_source import resolve_source

    _, dsn, timeout = resolve_source(db, slug)
    try:
        tables = pg.list_tables(dsn, timeout)
    except pg.PgSourceError as e:
        raise HTTPException(502, {"message": f"Postgres source query failed: {e}",
                                  "context": {"source": slug}}) from e
    allowed = set(pg_sources.list_allowed_schemas(db, slug))
    counts: dict[str, int] = {}
    for table in tables:
        counts[table["schema"]] = counts.get(table["schema"], 0) + 1
    return {"items": [
        {"schema": schema, "table_count": count, "allowed": schema in allowed}
        for schema, count in sorted(counts.items())
    ]}


@router.post("/{slug}/schemas", dependencies=_EDIT_GATE)
def set_pg_schema_unlock(
    slug: str, req: SchemaUnlock, db: Session = Depends(get_db),
    admin: str = Depends(require_sysadmin),
) -> dict:
    """스키마 단위 값 허용 토글 — MSSQL 허용 목록과 같은 표·같은 감사 로그에 남는다."""
    _require_source(db, slug)
    key = pg_sources.allowlist_key(slug, req.schema_name)
    now = datetime.now(UTC)
    row = db.get(PreviewAllowlist, key)
    if req.allowed and row is None:
        db.add(PreviewAllowlist(schema=key, note=req.note, added_by=admin, created_at=now))
    elif not req.allowed and row is not None:
        db.delete(row)
    db.add(AuditLog(action="preview_allow_add" if req.allowed else "preview_allow_remove",
                    detail=key, requested_by=admin, requested_at=now))
    return {"schema": key, "allowed": req.allowed}
