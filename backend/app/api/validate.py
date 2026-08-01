"""On-demand T2 validation — containment and history. / 온디맨드 T2 검증 (계획 §3)."""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.adapters import create_join_validator
from app.config import get_settings
from app.db import get_db
from app.domain.confidence import Observation, compute_confidence
from app.domain.validation import ColumnRef, JoinValidator, ValidationDataMissing
from app.models import CatalogColumn, CatalogObject, JoinValidationHistory, Relation

router = APIRouter(prefix="/api/validate", tags=["validate"])


def get_join_validator() -> JoinValidator:
    """설정 기반 검증기 — 테스트는 이 의존성을 오버라이드한다 / DI point for tests."""
    return create_join_validator(get_settings())


class ContainmentRequest(BaseModel):
    src_column_id: int
    tgt_column_id: int
    triggered_by: str = "local"


def resolve_column_ref(db: Session, column_id: int) -> tuple[ColumnRef, CatalogColumn]:
    """컬럼 id → 스냅샷 독립 텍스트 식별자 / snapshot id to textual identity."""
    row = db.execute(
        select(CatalogColumn, CatalogObject)
        .join(CatalogObject, CatalogColumn.object_id == CatalogObject.id)
        .where(CatalogColumn.id == column_id)
    ).one_or_none()
    if row is None:
        raise HTTPException(404, {"message": "column not found",
                                  "context": {"column_id": column_id}})
    col, obj = row
    return ColumnRef(obj.schema, obj.name, col.name), col


def _pair_filter(src: ColumnRef, tgt: ColumnRef):
    return (
        (JoinValidationHistory.src_object == src.object_qname)
        & (JoinValidationHistory.src_column == src.column)
        & (JoinValidationHistory.tgt_object == tgt.object_qname)
        & (JoinValidationHistory.tgt_column == tgt.column)
    )


@router.post("/containment")
def run_containment(
    req: ContainmentRequest,
    db: Session = Depends(get_db),
    validator: JoinValidator = Depends(get_join_validator),
) -> dict:
    """T2 — 지정 컬럼 페어 containment 검증, 결과는 영구 기록 (계획 §3.2·§3.4)."""
    src_ref, src_col = resolve_column_ref(db, req.src_column_id)
    tgt_ref, tgt_col = resolve_column_ref(db, req.tgt_column_id)

    try:
        result = validator.containment(src_ref, tgt_ref)
    except ValidationDataMissing as e:
        raise HTTPException(
            404, {"message": "no value data for column", "context": {"column": str(e.ref)}}
        ) from e

    now = datetime.now(UTC)
    db.add(JoinValidationHistory(
        src_object=src_ref.object_qname, src_column=src_ref.column,
        tgt_object=tgt_ref.object_qname, tgt_column=tgt_ref.column,
        containment=result.containment, orphan_count=result.orphan_count,
        cardinality=result.cardinality, src_row_count=result.src_row_count,
        observed_at=now, triggered_by=req.triggered_by,
    ))
    # 관측치로 컬럼 통계 채움 — 이후 저카디널리티 필터가 동작한다 (계획 §1.2·§3.3)
    src_col.distinct_count = result.src_distinct
    tgt_col.distinct_count = result.tgt_distinct
    db.flush()

    history = db.execute(
        select(JoinValidationHistory).where(_pair_filter(src_ref, tgt_ref))
    ).scalars().all()
    conf = compute_confidence([
        Observation(h.containment, h.src_row_count, h.observed_at) for h in history
    ])

    relation = db.execute(
        select(Relation).where(
            Relation.src_object == src_ref.object_qname,
            Relation.src_column == src_ref.column,
            Relation.tgt_object == tgt_ref.object_qname,
            Relation.tgt_column == tgt_ref.column,
        )
    ).scalar_one_or_none()
    if relation is None:
        relation = Relation(
            src_object=src_ref.object_qname, src_column=src_ref.column,
            tgt_object=tgt_ref.object_qname, tgt_column=tgt_ref.column,
            status="validated", origin="rule", created_at=now,
        )
        db.add(relation)
    elif relation.status != "confirmed":
        relation.status = "validated"  # 확정은 검증으로 강등되지 않는다 / confirm never demoted
    relation.confidence = conf.confidence
    relation.cardinality = result.cardinality
    relation.last_verified_at = now

    return {
        "src": str(src_ref), "tgt": str(tgt_ref),
        "containment": result.containment, "matched": result.matched,
        "src_distinct": result.src_distinct, "orphan_count": result.orphan_count,
        "cardinality": result.cardinality,
        "confidence": conf.confidence, "pattern": conf.pattern,
        "observations": conf.observation_count,
        "observed_at": now.isoformat(),
    }


@router.get("/history")
def get_validation_history(
    src_column_id: int, tgt_column_id: int, db: Session = Depends(get_db)
) -> dict:
    src_ref, _ = resolve_column_ref(db, src_column_id)
    tgt_ref, _ = resolve_column_ref(db, tgt_column_id)
    rows = db.execute(
        select(JoinValidationHistory)
        .where(_pair_filter(src_ref, tgt_ref))
        .order_by(JoinValidationHistory.observed_at.desc())
    ).scalars().all()
    return {"items": [
        {
            "containment": h.containment, "orphan_count": h.orphan_count,
            "cardinality": h.cardinality, "src_row_count": h.src_row_count,
            "observed_at": h.observed_at.isoformat(), "triggered_by": h.triggered_by,
        }
        for h in rows
    ]}
