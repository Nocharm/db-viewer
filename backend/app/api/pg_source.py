"""Secondary Postgres source — connection status, table list, row preview.
/ 업무 Postgres 소스 — 연결 상태·테이블 목록·행 미리보기.

MSSQL 카탈로그와 달리 이 소스는 **수집하지 않는다** — 목록도 미리보기도 그때그때
원본에 물어본다(스냅샷·ERD·조인 검증 대상이 아니다). 값이 나가는 문은 하나뿐이라는
원칙은 그대로라서, 미리보기 허용 목록에 `pg:<스키마>`가 올라간 스키마만 열린다.
Live lookups against the business Postgres; nothing is ingested.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.adapters import pg_source
from app.api.objects import (
    TABLE_PREVIEW_LIMIT, TABLE_PREVIEW_MAX, format_filter_note, parse_preview_filters,
)
from app.auth import get_current_user
from app.config import get_settings
from app.db import get_db
from app.models import AuditLog
from app.services.preview_policy import is_preview_allowed

router = APIRouter(prefix="/api/pg", tags=["pg-source"])

# 허용 목록 키 접두어 — MSSQL 스키마와 이름이 겹쳐도 서로 열리지 않게 한다
# / allowlist keys are namespaced so a same-named MSSQL schema never opens this source
ALLOWLIST_PREFIX = "pg:"


def allowlist_key(schema: str) -> str:
    return f"{ALLOWLIST_PREFIX}{schema}"


def _require_enabled() -> tuple[str, int]:
    settings = get_settings()
    if not settings.pg_source_enabled:
        raise HTTPException(503, {
            "message": "the Postgres source is not configured — set PG_SOURCE_DSN "
                       "(read-only account) and restart the backend",
            "context": {},
        })
    return settings.pg_source_dsn, settings.pg_source_timeout


@router.get("/status")
def get_pg_status(db: Session = Depends(get_db)) -> dict:
    """연결 설정 여부 + 접속 대상(자격증명 제외) + 허용된 스키마 / configured target, no credentials."""
    settings = get_settings()
    if not settings.pg_source_enabled:
        return {"enabled": False, "label": settings.pg_source_label, "connection": None,
                "allowed_schemas": []}
    return {
        "enabled": True,
        "label": settings.pg_source_label,
        "connection": pg_source.describe_dsn(settings.pg_source_dsn),
        "allowed_schemas": sorted(_allowed_pg_schemas(db)),
    }


def _allowed_pg_schemas(db: Session) -> set[str]:
    from app.services.preview_policy import list_allowed_schemas

    return {s[len(ALLOWLIST_PREFIX):] for s in list_allowed_schemas(db)
            if s.startswith(ALLOWLIST_PREFIX)}


@router.get("/tables")
def list_pg_tables() -> dict:
    """스키마·테이블 목록 (행 수는 추정치) — 이름은 값이 아니라 게이트 없이 나간다."""
    dsn, timeout = _require_enabled()
    try:
        items = pg_source.list_tables(dsn, timeout)
    except pg_source.PgSourceError as e:
        raise HTTPException(502, {"message": f"Postgres source query failed: {e}",
                                  "context": {}}) from e
    return {"items": items, "total": len(items)}


@router.get("/preview")
def get_pg_preview(
    schema: str = Query(..., max_length=128),
    table: str = Query(..., max_length=128),
    # AND 결합 조건 목록의 JSON — [{column, op, value}] (MSSQL 미리보기와 같은 형식)
    filters: str | None = Query(None, max_length=2000),
    limit: int = Query(TABLE_PREVIEW_LIMIT, ge=1, le=TABLE_PREVIEW_MAX),
    db: Session = Depends(get_db),
    login_id: str = Depends(get_current_user),
) -> dict:
    """미리보기 행 — 허용 스키마만, 무캐시, 감사 로그 필수 (MSSQL 경로와 같은 규약)."""
    dsn, timeout = _require_enabled()
    qname = f"{schema}.{table}"
    if not is_preview_allowed(db, allowlist_key(schema)):
        raise HTTPException(403, {
            "message": "preview is not allowed for this schema — an admin must add "
                       f"'{allowlist_key(schema)}' to the preview allowlist "
                       "(관리 콘솔 → 미리보기 허용 스키마)",
            "context": {"object": qname, "schema": allowlist_key(schema)},
        })

    try:
        columns = pg_source.list_columns(dsn, timeout, schema, table)
        if not columns:
            raise HTTPException(404, {"message": "table not found in the Postgres source",
                                      "context": {"object": qname}})
        conds = parse_preview_filters(filters, {c["name"] for c in columns})
        column_names = [c["name"] for c in columns]
        rows = pg_source.fetch_rows(dsn, timeout, schema, table, column_names, limit,
                                    [c.model_dump() for c in conds])
    except pg_source.PgSourceError as e:
        raise HTTPException(502, {"message": f"Postgres source query failed: {e}",
                                  "context": {"object": qname}}) from e

    now = datetime.now(UTC)
    db.add(AuditLog(action="pg_preview",
                    detail=f"{ALLOWLIST_PREFIX}{qname} ({len(rows)} rows)"
                           f"{format_filter_note(conds)}",
                    requested_by=login_id, requested_at=now))
    return {
        "object": qname,
        "columns": column_names,
        "rows": [{k: _jsonable(v) for k, v in row.items()} for row in rows],
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
