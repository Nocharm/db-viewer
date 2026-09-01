"""User confirmation of relations. / 사용자 확정 (계획 §3.6)."""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.validate import resolve_column_ref
from app.db import get_db
from app.models import AuditLog, CatalogColumn, CatalogObject, Relation, Snapshot
from app.models.sources import MANAGED_MSSQL_SOURCE_ID
from app.services.schema_visibility import is_schema_hidden

router = APIRouter(prefix="/api/relations", tags=["relations"])

PENDING_LIMIT = 100  # 대기 목록 한 화면 상한 — total로 절단 여부를 드러낸다


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
    if relation.status == "candidate":
        # AI·규칙 후보를 검증 없이 confirmed로 저장 금지 (계획 §5.2)
        # never persist an unvalidated candidate as confirmed
        raise HTTPException(400, {
            "message": "candidate must pass containment validation before confirmation",
            "context": {"src": str(src_ref), "tgt": str(tgt_ref), "origin": relation.origin},
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


@router.get("/pending")
def list_pending_relations(db: Session = Depends(get_db)) -> dict:
    """검증 대기 관계 — candidate(제안)·validated(T2 통과, 미확정) (스펙 §/verify)."""
    rows = db.execute(
        select(Relation)
        .where(Relation.status.in_(("candidate", "validated")))
        .order_by(Relation.created_at.desc())
    ).scalars().all()
    rows = [r for r in rows
            if not is_schema_hidden(r.src_object.split(".", 1)[0])
            and not is_schema_hidden(r.tgt_object.split(".", 1)[0])]

    # 프리필용 현 스냅샷 id 매핑 — 관계는 텍스트 식별자라 스냅샷 교체에도 산다.
    # 사내 MSSQL 소스로 고정한다: 관계 검증은 MSSQL 전용 기능이고(스펙 비목표), 스냅샷
    # id는 전 소스 공통 시퀀스라 소스를 안 걸면 나중에 수집된 PG/SQLite 스냅샷이 최댓값을
    # 가져가 프리필이 전부 null이 된다(오류 없이 /verify 진입만 조용히 죽는다).
    # / pinned to the managed MSSQL source: relation verification is MSSQL-only and
    #   snapshot ids are one global sequence, so an unscoped max() silently prefills nulls
    latest_sid = db.execute(
        select(func.max(CatalogObject.snapshot_id))
        .join(Snapshot, Snapshot.id == CatalogObject.snapshot_id)
        .where(Snapshot.data_source_id == MANAGED_MSSQL_SOURCE_ID)
    ).scalar_one_or_none()
    obj_ids: dict[str, int] = {}
    col_ids: dict[tuple[int, str], int] = {}
    if latest_sid is not None:
        for oid, schema, name in db.execute(
            select(CatalogObject.id, CatalogObject.schema, CatalogObject.name)
            .where(CatalogObject.snapshot_id == latest_sid)
        ):
            obj_ids[f"{schema}.{name}"] = oid
        for cid, oid, cname in db.execute(
            select(CatalogColumn.id, CatalogColumn.object_id, CatalogColumn.name)
            .join(CatalogObject, CatalogColumn.object_id == CatalogObject.id)
            .where(CatalogObject.snapshot_id == latest_sid)
        ):
            col_ids[(oid, cname)] = cid

    def _resolve(qname: str, column: str) -> tuple[int | None, int | None]:
        oid = obj_ids.get(qname)
        return oid, (col_ids.get((oid, column)) if oid is not None else None)

    items = []
    for r in rows[:PENDING_LIMIT]:
        src_oid, src_cid = _resolve(r.src_object, r.src_column)
        tgt_oid, tgt_cid = _resolve(r.tgt_object, r.tgt_column)
        items.append({
            "id": r.id, "status": r.status, "origin": r.origin,
            "confidence": r.confidence, "reason": r.reason,
            "src_object": r.src_object, "src_column": r.src_column,
            "tgt_object": r.tgt_object, "tgt_column": r.tgt_column,
            "src_object_id": src_oid, "src_column_id": src_cid,
            "tgt_object_id": tgt_oid, "tgt_column_id": tgt_cid,
        })
    return {"items": items, "total": len(rows)}
