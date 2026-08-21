"""Business-Postgres sources — status, table list, row preview.
/ 업무 Postgres 소스 — 상태·테이블 목록·행 미리보기.

MSSQL 카탈로그와 달리 이 소스들은 **수집하지 않는다** — 목록도 미리보기도 그때그때
원본에 묻는다(스냅샷·ERD·조인 검증 대상이 아니다). 값이 나가는 문은 하나뿐이라는
원칙은 그대로라서, 미리보기 허용 목록에 `pg:<slug>:<스키마>`가 올라간 것만 열린다.
연결 등록·수정은 관리 라우터(`/api/admin/pg-sources`)가 담당한다.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.adapters import pg_source as pg
from app.api.objects import (
    TABLE_PREVIEW_LIMIT, TABLE_PREVIEW_MAX, format_filter_note, parse_preview_filters,
)
from app.auth import get_current_user
from app.config import get_settings
from app.db import get_db
from app.models import AuditLog, PgSource
from app.services import pg_sources

router = APIRouter(prefix="/api/pg", tags=["pg-source"])


def resolve_source(db: Session, slug: str) -> tuple[PgSource, str, int]:
    """등록된 소스 + 접속 문자열 — 키 미설정·미등록은 여기서 걸린다 / source and its DSN."""
    settings = get_settings()
    source = pg_sources.get_source(db, slug)
    if source is None:
        raise HTTPException(404, {"message": "unknown Postgres source",
                                  "context": {"source": slug}})
    try:
        return source, pg_sources.build_dsn(settings, source), settings.pg_source_timeout
    except (pg_sources.PgSecretMissing, pg_sources.PgSecretMismatch) as e:
        raise HTTPException(503, {"message": str(e), "context": {"source": slug}}) from e


@router.get("/status")
def get_pg_status(db: Session = Depends(get_db)) -> dict:
    """등록된 소스 목록 — 화면 메뉴·소스 선택기의 근거. 접속 정보·비밀번호는 담지 않는다."""
    settings = get_settings()
    sources = pg_sources.list_sources(db) if settings.pg_source_enabled else []
    return {
        # 키가 없으면 등록이 있어도 쓸 수 없다 — 화면은 이 값 하나로 메뉴를 감춘다
        "enabled": settings.pg_source_enabled and bool(sources),
        "secret_configured": settings.pg_source_enabled,
        "sources": [
            {"slug": s.slug, "label": s.label, "database": s.database,
             "allowed_schemas": pg_sources.list_allowed_schemas(db, s.slug)}
            for s in sources
        ],
    }


@router.get("/tables")
def list_pg_tables(
    source: str = Query(..., max_length=40), db: Session = Depends(get_db),
) -> dict:
    """스키마·테이블 목록 (행 수는 추정치) — 이름은 값이 아니라 게이트 없이 나간다."""
    _, dsn, timeout = resolve_source(db, source)
    try:
        items = pg.list_tables(dsn, timeout)
    except pg.PgSourceError as e:
        raise HTTPException(502, {"message": f"Postgres source query failed: {e}",
                                  "context": {"source": source}}) from e
    return {"items": items, "total": len(items)}


@router.get("/preview")
def get_pg_preview(
    source: str = Query(..., max_length=40),
    schema: str = Query(..., max_length=128),
    table: str = Query(..., max_length=128),
    # AND 결합 조건 목록의 JSON — [{column, op, value}] (MSSQL 미리보기와 같은 형식)
    filters: str | None = Query(None, max_length=2000),
    limit: int = Query(TABLE_PREVIEW_LIMIT, ge=1, le=TABLE_PREVIEW_MAX),
    db: Session = Depends(get_db),
    login_id: str = Depends(get_current_user),
) -> dict:
    """미리보기 행 — 허용 스키마만, 무캐시, 감사 로그 필수 (MSSQL 경로와 같은 규약)."""
    row, dsn, timeout = resolve_source(db, source)
    qname = f"{schema}.{table}"
    if not pg_sources.is_schema_allowed(db, source, schema):
        key = pg_sources.allowlist_key(source, schema)
        raise HTTPException(403, {
            "message": "preview is not allowed for this schema — an admin must unlock "
                       f"'{key}' (관리 콘솔 → 업무 Postgres 연결 → 스키마 허용)",
            "context": {"object": qname, "source": source, "schema": key},
        })

    try:
        columns = pg.list_columns(dsn, timeout, schema, table)
        if not columns:
            raise HTTPException(404, {"message": "table not found in the Postgres source",
                                      "context": {"source": source, "object": qname}})
        conds = parse_preview_filters(filters, {c["name"] for c in columns})
        column_names = [c["name"] for c in columns]
        rows = pg.fetch_rows(dsn, timeout, schema, table, column_names, limit,
                             [c.model_dump() for c in conds])
    except pg.PgSourceError as e:
        raise HTTPException(502, {"message": f"Postgres source query failed: {e}",
                                  "context": {"source": source, "object": qname}}) from e

    now = datetime.now(UTC)
    db.add(AuditLog(action="pg_preview",
                    detail=f"{row.slug}:{qname} ({len(rows)} rows)"
                           f"{format_filter_note(conds)}",
                    requested_by=login_id, requested_at=now))
    return {
        # 화면 탭 제목 — 소스가 여럿이라 어느 DB의 테이블인지 함께 보여준다
        "object": qname,
        "source_label": row.label,
        "columns": column_names,
        "rows": [{k: _jsonable(v) for k, v in r.items()} for r in rows],
        # 이 소스에는 카탈로그가 없어 컬럼 단위 마스킹 정책도 없다 (스키마 단위 게이트만)
        "masked_columns": [],
        "source": "pg",
        "limit": limit,
        "filters": [c.model_dump() for c in conds],
        "observed_at": now.isoformat(),
    }


def _jsonable(value: object) -> object:
    """date·numeric·uuid 등 PG 고유 타입을 문자열로 — 미리보기는 보여주기만 한다."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)
