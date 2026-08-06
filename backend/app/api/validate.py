"""On-demand T2 validation — containment and history. / 온디맨드 T2 검증 (계획 §3)."""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.adapters import create_join_validator
from app.config import get_settings
from app.db import get_db
from app.domain.validation import ColumnRef, JoinValidator, ValidationDataMissing
from app.models import AuditLog, CatalogColumn, CatalogObject, JoinValidationHistory
from app.services.observations import record_observation
from app.services.preview_policy import is_preview_allowed

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
    # 관측치로 컬럼 통계 채움 — 이후 저카디널리티 필터가 동작한다 (계획 §1.2·§3.3)
    src_col.distinct_count = result.src_distinct
    tgt_col.distinct_count = result.tgt_distinct
    conf = record_observation(db, src_ref, tgt_ref, result, req.triggered_by, now)

    return {
        "src": str(src_ref), "tgt": str(tgt_ref),
        "containment": result.containment, "matched": result.matched,
        "src_distinct": result.src_distinct, "orphan_count": result.orphan_count,
        "cardinality": result.cardinality,
        "confidence": conf.confidence, "pattern": conf.pattern,
        "observations": conf.observation_count,
        "observed_at": now.isoformat(),
    }


class PreviewRequest(BaseModel):
    src_column_id: int
    tgt_column_id: int
    requested_by: str = "local"


# TOP 20 고정 — 클라이언트가 늘릴 수 없다 (계획 §3.5) / hard cap, not client-controlled
PREVIEW_LIMIT = 20


@router.post("/preview")
def run_preview(
    req: PreviewRequest,
    db: Session = Depends(get_db),
    validator: JoinValidator = Depends(get_join_validator),
) -> dict:
    """조인 샘플 미리보기 — 원본 값이 나가는 유일한 지점: 무캐시·마스킹·감사 (계획 §3.5)."""
    src_ref, src_col = resolve_column_ref(db, req.src_column_id)
    tgt_ref, tgt_col = resolve_column_ref(db, req.tgt_column_id)
    # 조인 샘플도 양쪽 테이블의 실값을 내보낸다 — 테이블 미리보기와 같은 허용 목록을 쓴다
    # (여기가 열려 있으면 허용 목록이 우회된다)
    blocked = [ref.object_qname for ref in (src_ref, tgt_ref)
               if not is_preview_allowed(db, ref.object_qname.split(".", 1)[0])]
    if blocked:
        raise HTTPException(403, {
            "message": "preview is not allowed for these objects — an admin must add "
                       "their schemas to the preview allowlist (관리 콘솔 → 미리보기 허용 스키마)",
            "context": {"objects": blocked},
        })

    try:
        rows = validator.preview(src_ref, tgt_ref, PREVIEW_LIMIT)
    except ValidationDataMissing as e:
        raise HTTPException(
            404, {"message": "no value data for column", "context": {"column": str(e.ref)}}
        ) from e

    # 컬럼 단위 마스킹 정책 적용 (계획 §3.5) / per-column masking policy
    masked_keys = set()
    if src_col.masking_policy:
        masked_keys.add(f"src.{src_ref.column}")
    if tgt_col.masking_policy:
        masked_keys.add(f"tgt.{tgt_ref.column}")
    if masked_keys:
        rows = [
            {k: ("●●●" if k in masked_keys else v) for k, v in row.items()}
            for row in rows
        ]

    now = datetime.now(UTC)
    db.add(AuditLog(
        action="preview",
        detail=f"{src_ref} -> {tgt_ref} ({len(rows)} rows)",
        requested_by=req.requested_by, requested_at=now,
    ))
    return {
        "src": str(src_ref), "tgt": str(tgt_ref),
        "rows": rows, "limit": PREVIEW_LIMIT,
        "masked_columns": sorted(masked_keys),
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
