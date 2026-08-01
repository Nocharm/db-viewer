"""User confirmation of relations. / 사용자 확정 (계획 §3.6)."""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.validate import resolve_column_ref
from app.db import get_db
from app.models import AuditLog, Relation

router = APIRouter(prefix="/api/relations", tags=["relations"])


class ConfirmRequest(BaseModel):
    src_column_id: int
    tgt_column_id: int
    confirmed_by: str = "local"


@router.post("/confirm")
def confirm_relation(req: ConfirmRequest, db: Session = Depends(get_db)) -> dict:
    """검증된 관계를 confirmed로 승격 — 이후 스코어링의 정답셋 (계획 §3.6)."""
    src_ref, _ = resolve_column_ref(db, req.src_column_id)
    tgt_ref, _ = resolve_column_ref(db, req.tgt_column_id)

    relation = db.execute(
        select(Relation).where(
            Relation.src_object == src_ref.object_qname,
            Relation.src_column == src_ref.column,
            Relation.tgt_object == tgt_ref.object_qname,
            Relation.tgt_column == tgt_ref.column,
        )
    ).scalar_one_or_none()
    if relation is None:
        # 확정은 검증을 전제한다 / confirmation requires a prior validation
        raise HTTPException(404, {
            "message": "relation not found — run containment validation first",
            "context": {"src": str(src_ref), "tgt": str(tgt_ref)},
        })

    relation.status = "confirmed"
    db.add(AuditLog(
        action="confirm", detail=f"{src_ref} -> {tgt_ref}",
        requested_by=req.confirmed_by, requested_at=datetime.now(UTC),
    ))
    return {
        "src": str(src_ref), "tgt": str(tgt_ref),
        "status": relation.status, "confidence": relation.confidence,
        "cardinality": relation.cardinality,
        "last_verified_at": (
            relation.last_verified_at.isoformat() if relation.last_verified_at else None
        ),
    }
