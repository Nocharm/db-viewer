"""Relation candidate lookup for a column. / 컬럼의 관계 후보 조회 (T1 — 메타데이터만)."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.domain import scoring
from app.models import (
    CatalogColumn,
    CatalogConstraint,
    CatalogObject,
    FkColumn,
    ViewJoin,
)

router = APIRouter(prefix="/api/columns", tags=["columns"])


def load_scoring_columns(db: Session, snapshot_id: int) -> dict[int, scoring.ScoringColumn]:
    """스냅샷 전체 컬럼을 스코어링 입력으로 적재 / all columns as scoring inputs."""
    rows = db.execute(
        select(CatalogColumn, CatalogObject.schema, CatalogObject.name, CatalogObject.type)
        .join(CatalogObject, CatalogColumn.object_id == CatalogObject.id)
        .where(CatalogObject.snapshot_id == snapshot_id)
    )
    return {
        col.id: scoring.ScoringColumn(
            column_id=col.id, object_qname=f"{schema}.{name}", object_type=obj_type,
            name=col.name, data_type=col.data_type, max_length=col.max_length,
            is_pk=col.is_pk, is_computed=col.is_computed, distinct_count=col.distinct_count,
        )
        for col, schema, name, obj_type in rows
    }


def load_pair_sets(db: Session, snapshot_id: int) -> tuple[set[frozenset], set[frozenset]]:
    """(뷰 JOIN 페어, 기존 FK 페어) / (view-join pairs, existing FK pairs)."""
    view_pairs = {
        frozenset((left, right))
        for left, right in db.execute(
            select(ViewJoin.left_column_id, ViewJoin.right_column_id)
            .where(ViewJoin.snapshot_id == snapshot_id)
        )
    }
    fk_pairs = {
        frozenset((src, tgt))
        for src, tgt in db.execute(
            select(FkColumn.src_column_id, FkColumn.tgt_column_id)
            .join(CatalogConstraint, FkColumn.constraint_id == CatalogConstraint.id)
            .where(CatalogConstraint.snapshot_id == snapshot_id)
        )
    }
    return view_pairs, fk_pairs


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
