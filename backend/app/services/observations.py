"""Shared observation recording for T2/T3. / T2·T3 공용 관측 기록·confidence 갱신."""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.confidence import ConfidenceResult, Observation, compute_confidence
from app.domain.validation import ColumnRef, ContainmentResult
from app.models import JoinValidationHistory, Relation


def record_observation(
    db: Session,
    src_ref: ColumnRef,
    tgt_ref: ColumnRef,
    result: ContainmentResult,
    triggered_by: str,
    observed_at: datetime,
) -> ConfidenceResult:
    """이력 적재 → confidence 재계산 → 관계 상태 upsert (계획 §3.4)."""
    db.add(JoinValidationHistory(
        src_object=src_ref.object_qname, src_column=src_ref.column,
        tgt_object=tgt_ref.object_qname, tgt_column=tgt_ref.column,
        containment=result.containment, orphan_count=result.orphan_count,
        cardinality=result.cardinality, src_row_count=result.src_row_count,
        observed_at=observed_at, triggered_by=triggered_by,
    ))
    db.flush()

    history = db.execute(
        select(JoinValidationHistory).where(
            JoinValidationHistory.src_object == src_ref.object_qname,
            JoinValidationHistory.src_column == src_ref.column,
            JoinValidationHistory.tgt_object == tgt_ref.object_qname,
            JoinValidationHistory.tgt_column == tgt_ref.column,
        )
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
            status="validated", origin="rule", created_at=observed_at,
        )
        db.add(relation)
    elif relation.status != "confirmed":
        relation.status = "validated"  # 확정은 강등되지 않는다 / confirm never demoted
    relation.confidence = conf.confidence
    relation.cardinality = result.cardinality
    relation.last_verified_at = observed_at
    return conf
