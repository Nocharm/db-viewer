"""Multi-table join preview — N-way join over validated column pairs.
/ N-웨이 조인 미리보기 (스펙 2026-08-05 §3.3)."""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.validate import get_join_validator, resolve_column_ref
from app.db import get_db
from app.domain.validation import JoinStepRef, JoinValidator, ValidationDataMissing
from app.models import AuditLog

router = APIRouter(prefix="/api/join", tags=["join"])

# TOP 20 고정 — 클라이언트가 늘릴 수 없다 (계획 §3.5와 같은 규약)
PREVIEW_LIMIT = 20
# 조인 단계 상한 — join_check.BATCH_TARGET_LIMIT과 같은 값 / same cap as batch join check
MAX_STEPS = 8


class JoinStepIn(BaseModel):
    left_column_id: int
    right_column_id: int
    join_type: str = Field(default="inner", pattern="^(inner|left)$")


class JoinPreviewRequest(BaseModel):
    steps: list[JoinStepIn] = Field(min_length=1)
    requested_by: str = "local"


def _check_connectivity(steps: list[JoinStepRef]) -> None:
    """끊긴 조인은 곱집합이 된다 — 각 스텝은 이미 들어온 테이블과 이어져야 한다."""
    seen: set[str] = set()
    for index, step in enumerate(steps):
        left = f"{step.left_schema}.{step.left_table}"
        right = f"{step.right_schema}.{step.right_table}"
        if left == right:
            raise HTTPException(400, {
                "message": "join step connects a table to itself",
                "context": {"step": index, "table": left},
            })
        if index == 0:
            seen.update({left, right})
            continue
        if left not in seen and right not in seen:
            raise HTTPException(400, {
                "message": "disconnected join step",
                "context": {"step": index, "left": left, "right": right,
                            "joined": sorted(seen)},
            })
        seen.update({left, right})


@router.post("/preview")
def run_join_preview(
    req: JoinPreviewRequest,
    db: Session = Depends(get_db),
    validator: JoinValidator = Depends(get_join_validator),
) -> dict:
    """N-웨이 조인 샘플 — 원본 값이 나가는 지점: 무캐시·마스킹·감사 (스펙 §3.3)."""
    if len(req.steps) > MAX_STEPS:
        raise HTTPException(400, {
            "message": f"too many join steps (max {MAX_STEPS})",
            "context": {"steps": len(req.steps)},
        })

    refs: list[JoinStepRef] = []
    masked_keys: set[str] = set()
    for step in req.steps:
        left_ref, left_col = resolve_column_ref(db, step.left_column_id)
        right_ref, right_col = resolve_column_ref(db, step.right_column_id)
        refs.append(JoinStepRef(
            left_schema=left_ref.schema, left_table=left_ref.table,
            left_column=left_ref.column,
            right_schema=right_ref.schema, right_table=right_ref.table,
            right_column=right_ref.column,
            join_type=step.join_type,
        ))
        # W2가 "테이블.컬럼"으로 별칭을 붙인다 — 마스킹 키를 같은 규칙으로 만든다
        if left_col.masking_policy:
            masked_keys.add(f"{left_ref.table}.{left_ref.column}")
        if right_col.masking_policy:
            masked_keys.add(f"{right_ref.table}.{right_ref.column}")

    _check_connectivity(refs)

    try:
        rows, query = validator.multi_join_preview(refs, PREVIEW_LIMIT)
    except ValidationDataMissing as e:
        raise HTTPException(
            404, {"message": "no value data for column", "context": {"column": str(e.ref)}}
        ) from e
    except NotImplementedError as e:
        raise HTTPException(
            503,
            {"message": "join preview is unavailable without a live source",
             "context": {"reason": str(e)}},
        ) from e

    if masked_keys:
        rows = [
            {k: ("●●●" if k in masked_keys else v) for k, v in row.items()}
            for row in rows
        ]

    now = datetime.now(UTC)
    path = " -> ".join(
        f"{s.left_schema}.{s.left_table}.{s.left_column}"
        f"={s.right_schema}.{s.right_table}.{s.right_column}" for s in refs
    )
    db.add(AuditLog(
        action="join_preview",
        detail=f"{path} ({len(rows)} rows)",
        requested_by=req.requested_by, requested_at=now,
    ))
    return {
        "rows": rows, "query": query, "limit": PREVIEW_LIMIT,
        "masked_columns": sorted(masked_keys),
        "observed_at": now.isoformat(),
    }
