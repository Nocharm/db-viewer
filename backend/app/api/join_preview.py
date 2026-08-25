"""Multi-table join preview — N-way join over validated column pairs.
/ N-웨이 조인 미리보기 (스펙 2026-08-05 §3.3)."""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import String
from sqlalchemy.orm import Session

from app.api.validate import ensure_not_hidden, get_join_validator, resolve_column_ref
from app.db import get_db
from app.domain.validation import JoinStepRef, JoinValidator, ValidationDataMissing
from app.models import AuditLog
from app.models.sources import MANAGED_MSSQL_SOURCE_ID
from app.services.preview_policy import is_preview_allowed

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
    """끊긴 조인은 곱집합이 된다 — 각 스텝은 이미 들어온 테이블과 이어져야 한다.

    양쪽이 이미 다 들어온 스텝(닫는 edge)은 SQL에서 새 JOIN이 아니라 기존 clause에
    AND로 붙는다 — 그 지점엔 독립된 LEFT/RIGHT 방향이 없어(주변 JOIN이 이미 그 테이블의
    보존 여부를 결정했다) join_type=left를 만족시킬 방법이 없다. 조용히 무시하는 대신
    여기서 막는다 — UI는 그 스텝에 계속 LEFT 배지를 보여주므로 무시하면 배지가 거짓말이 된다.
    A closing edge (both sides already bound) becomes an AND on an existing clause, not a
    new JOIN — there is no independent LEFT/RIGHT direction left to honour there. Reject
    instead of silently dropping join_type=left, since the UI still shows a LEFT badge.
    """
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
        left_seen, right_seen = left in seen, right in seen
        if not left_seen and not right_seen:
            raise HTTPException(400, {
                "message": "disconnected join step",
                "context": {"step": index, "left": left, "right": right,
                            "joined": sorted(seen)},
            })
        if left_seen and right_seen and step.join_type == "left":
            raise HTTPException(400, {
                "message": "left join is not supported between two already-joined tables",
                "context": {"step": index, "left": left, "right": right},
            })
        seen.update({left, right})


# 절단 표시 — 감사 기록에서 잘렸음을 바로 알 수 있게
_TRUNCATION_MARKER = "...(truncated)"


def _build_audit_detail(refs: list[JoinStepRef], row_count: int) -> str:
    """`AuditLog.detail` 컬럼 길이 안에 맞춘다 — 단계 수·행 수는 무조건 남기고
    조인 경로는 남는 공간만큼만 담아, 잘렸으면 마커로 표시한다.

    MSSQL 식별자는 최대 128자라 8스텝 전체 경로는 이론상 ~6200자까지 갈 수
    있는데 컬럼은 600자 고정(컬럼 확대는 SQLite 배치모드 마이그레이션까지
    끌고 오는 과잉 대응이라 보류) — 여기서 자르지 않으면 프로덕션(Postgres)
    커밋 시 길이 초과 예외로 정상 요청이 500으로 죽는다. 컬럼 길이는 모델에서
    직접 읽어, 나중에 컬럼을 넓혀도 이 값이 조용히 안 맞아지는 일이 없게 한다.
    Bounds the detail to the AuditLog.detail column length so a legitimate
    maximal join never 500s on commit; reads the limit from the model itself.
    """
    # Column.type는 TypeEngine[Any]로 타입 지정돼 .length가 안 보인다 — 모델 선언이
    # String(600)임을 알고 있으므로 isinstance로 좁힌다 (n8n_query 테스트의 NODE_BIN
    # 좁히기와 같은 패턴). narrows the generic TypeEngine to String so pyright sees .length.
    detail_type = AuditLog.__table__.c.detail.type
    assert isinstance(detail_type, String) and detail_type.length is not None
    limit = detail_type.length
    suffix = f" ({len(refs)} steps, {row_count} rows)"
    path = " -> ".join(
        f"{s.left_schema}.{s.left_table}.{s.left_column}"
        f"={s.right_schema}.{s.right_table}.{s.right_column}" for s in refs
    )
    budget = limit - len(suffix)
    if len(path) <= budget:
        return f"{path}{suffix}"
    truncated = path[: budget - len(_TRUNCATION_MARKER)] + _TRUNCATION_MARKER
    return f"{truncated}{suffix}"


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
    # 등장 순서를 지키며 중복 제거 — 한 테이블이 여러 스텝에 걸쳐도 오류에 한 번만 싣는다
    # / dedupe while preserving order: a table spanning several steps is reported once
    involved: dict[str, str] = {}
    for step in req.steps:
        left_ref, left_col = resolve_column_ref(db, step.left_column_id)
        right_ref, right_col = resolve_column_ref(db, step.right_column_id)
        ensure_not_hidden(left_ref, right_ref)
        for ref in (left_ref, right_ref):
            involved.setdefault(f"{ref.schema}.{ref.table}", ref.schema)
        refs.append(JoinStepRef(
            left_schema=left_ref.schema, left_table=left_ref.table,
            left_column=left_ref.column,
            right_schema=right_ref.schema, right_table=right_ref.table,
            right_column=right_ref.column,
            join_type=step.join_type,
        ))
        # W2가 "스키마.테이블.컬럼"으로 별칭을 붙인다 — 마스킹 키를 같은 규칙으로 만든다.
        # 테이블명만 쓰면 스키마가 다른 동명 테이블(ATM.PI_x / SAP.PI_x)을 함께 조인할 때
        # 별칭이 겹쳐 응답 JSON에서 한쪽 값이 다른 쪽을 덮어쓴다 — 마스킹 이전에 데이터
        # 자체가 틀려지는 문제라 스키마까지 포함해야 한다.
        if left_col.masking_policy:
            masked_keys.add(f"{left_ref.schema}.{left_ref.table}.{left_ref.column}")
        if right_col.masking_policy:
            masked_keys.add(f"{right_ref.schema}.{right_ref.table}.{right_ref.column}")

    # N-웨이 조인도 참여 테이블 전부의 실값을 한 행에 실어 내보낸다 — validate.py:/preview와
    # 같은 허용 목록을 쓴다. 스텝 하나라도 닫힌 스키마를 물면 전부 막는다: 조인 결과 행은
    # 열린 쪽과 닫힌 쪽 컬럼이 같이 붙어 나오므로 부분 허용이라는 게 성립하지 않는다.
    # / an N-way join emits values from every participating table in the same row, so it
    # uses the same allowlist as validate.py's /preview. One closed schema blocks the whole
    # request — a joined row carries open and closed columns side by side, so there is no
    # meaningful "partially allowed" result to return.
    # 검증기는 사내 MSSQL 실행기 하나뿐이라 기본 소스로 판정한다 (validate.py:/preview 동일)
    blocked = [qname for qname, schema in involved.items()
               if not is_preview_allowed(db, MANAGED_MSSQL_SOURCE_ID, schema)]
    if blocked:
        raise HTTPException(403, {
            "message": "preview is not allowed for these objects — an admin must add "
                       "their schemas to the preview allowlist (관리 콘솔 → 미리보기 허용 스키마)",
            "context": {"objects": blocked},
        })

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
    except RuntimeError as e:
        # n8n_query._post_query가 여기서 올리는 두 경우 — 재시도 후에도 n8n 호출 실패,
        # 또는 W2가 실행문을 안 돌려줌(재배포 필요) — 잡지 않으면 프론트에 맨 "500"만
        # 보이고 이 메시지의 원인 설명이 전달되지 않는다 (NotImplementedError는 이미
        # RuntimeError의 하위클래스라 이 except보다 먼저 걸려야 한다)
        # both RuntimeErrors n8n_query._post_query can raise here — retries exhausted, or
        # W2 didn't return the executed SQL — must be caught or the frontend only sees a
        # bare 500 and this message's explanation never reaches anyone. NotImplementedError
        # is a RuntimeError subclass, so its except clause must stay above this one.
        raise HTTPException(
            502,
            {"message": "join preview failed against the source database",
             "context": {"reason": str(e)}},
        ) from e

    if masked_keys:
        rows = [
            {k: ("●●●" if k in masked_keys else v) for k, v in row.items()}
            for row in rows
        ]

    now = datetime.now(UTC)
    db.add(AuditLog(
        action="join_preview",
        detail=_build_audit_detail(refs, len(rows)),
        requested_by=req.requested_by, requested_at=now,
    ))
    return {
        "rows": rows, "query": query, "limit": PREVIEW_LIMIT,
        "masked_columns": sorted(masked_keys),
        "observed_at": now.isoformat(),
    }
