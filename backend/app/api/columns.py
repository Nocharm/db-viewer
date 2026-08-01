"""Relation candidate lookup for a column. / 컬럼의 관계 후보 조회 (T1 — 메타데이터만)."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.domain import scoring
from app.models import CatalogColumn, CatalogObject
from app.services.catalog_queries import load_pair_sets, load_scoring_columns

router = APIRouter(prefix="/api/columns", tags=["columns"])


@router.get("/{column_id}/candidates")
def get_relation_candidates(
    column_id: int,
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> dict:
    row = db.execute(
        select(CatalogColumn, CatalogObject)
        .join(CatalogObject, CatalogColumn.object_id == CatalogObject.id)
        .where(CatalogColumn.id == column_id)
    ).one_or_none()
    if row is None:
        raise HTTPException(404, {"message": "column not found",
                                  "context": {"column_id": column_id}})
    col, obj = row

    settings = get_settings()
    blacklist = {name.upper() for name in settings.low_cardinality_blacklist}
    columns = load_scoring_columns(db, obj.snapshot_id)
    src = columns[col.id]

    exclusion = scoring.check_exclusion(
        src, settings.low_cardinality_min_distinct, blacklist
    )
    if exclusion is not None:
        # UI는 배지 + 사유 노출 (계획 §3.3) / surfaced as a badge with the reason
        return {"column_id": col.id, "excluded": {"reason": exclusion}, "candidates": []}

    view_pairs, fk_pairs = load_pair_sets(db, obj.snapshot_id)
    candidates = scoring.score_candidates(
        src, list(columns.values()), view_pairs, fk_pairs,
        settings.low_cardinality_min_distinct, blacklist,
    )
    return {
        "column_id": col.id,
        "column": f"{src.object_qname}.{src.name}",
        "excluded": None,
        "candidates": [
            {
                "column_id": c.target.column_id,
                "object": c.target.object_qname,
                "column": c.target.name,
                "score": c.score,
                "signals": c.signals,
                "is_pk": c.target.is_pk,
            }
            for c in candidates[:limit]
        ],
    }
