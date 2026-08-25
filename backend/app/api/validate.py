"""On-demand T2 validation — containment and history. / 온디맨드 T2 검증 (계획 §3)."""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.adapters import create_join_validator
from app.config import get_settings
from app.db import get_db
from app.domain import scoring
from app.domain.validation import ColumnRef, JoinValidator, ValidationDataMissing
from app.models import AuditLog, CatalogColumn, CatalogObject, JoinValidationHistory
from app.models.sources import MANAGED_MSSQL_SOURCE_ID
from app.services.catalog_queries import load_pair_sets, load_scoring_columns
from app.services.observations import record_observation
from app.services.preview_policy import is_preview_allowed
from app.services.schema_visibility import is_schema_hidden

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


def ensure_not_hidden(*refs: ColumnRef) -> None:
    """감춘 스키마의 컬럼은 어떤 검증 경로에도 들어올 수 없다.

    컬럼 목록을 감춰도 column_id만 알면 판정·미리보기가 되면 감춘 의미가 없다 —
    id는 카탈로그에 그대로 있으므로(이름은 계속 노출된다) 여기서 명시적으로 막는다.
    미리보기 허용 목록과 독립이다: 허용돼 있어도 감춘 스키마면 막힌다.
    / hiding the column list means nothing if a known column_id still validates or
      previews. Ids remain resolvable by design, so the block has to be explicit here.
    """
    blocked = sorted({ref.object_qname for ref in refs if is_schema_hidden(ref.schema)})
    if blocked:
        raise HTTPException(403, {
            "message": "these objects are in a hidden schema — their columns are not "
                       "served and cannot be validated (HIDDEN_SCHEMAS)",
            "context": {"objects": blocked},
        })


class GateRequest(BaseModel):
    src_column_id: int
    tgt_column_id: int


def _build_gate_side(
    ref: ColumnRef, col: CatalogColumn, family: str, cached: bool
) -> dict:
    ratio = None
    if col.sample_rows is not None and col.sample_distinct is not None:
        # 빈 표본은 중복의 증거가 없다 — 차단 근거로 쓰지 않는다 (ratio 1.0)
        ratio = (col.sample_distinct / col.sample_rows) if col.sample_rows else 1.0
    return {
        "qname": ref.object_qname, "column": ref.column,
        "data_type": col.data_type, "family": family,
        "sample_rows": col.sample_rows, "sample_distinct": col.sample_distinct,
        "ratio": ratio, "cached": cached,
    }


def _ensure_sample_stats(
    col: CatalogColumn, ref: ColumnRef, validator: JoinValidator, top: int
) -> bool:
    """샘플 통계 확보 — 캐시 적중이면 True. 미스면 조회해 컬럼에 기록."""
    if col.sample_rows is not None and col.sample_distinct is not None:
        return True
    col.sample_rows, col.sample_distinct = validator.sample_stats(ref, top)
    col.sampled_at = datetime.now(UTC)
    return False


@router.post("/gate")
def run_gate(
    req: GateRequest,
    db: Session = Depends(get_db),
    validator: JoinValidator = Depends(get_join_validator),
) -> dict:
    """조인 사전 게이트 — 타입 패밀리(쿼리 0회) → TOP-N 유니크니스(캐시) 순 차단.

    값 겹침은 판정하지 않는다: TOP-N은 클러스터드 인덱스 순서라 실제로 조인되는
    페어도 표본끼리는 안 겹칠 수 있다 (스펙 §게이트). 원본 값 비노출 — 감사 대상 아님.
    """
    src_ref, src_col = resolve_column_ref(db, req.src_column_id)
    tgt_ref, tgt_col = resolve_column_ref(db, req.tgt_column_id)
    ensure_not_hidden(src_ref, tgt_ref)
    settings = get_settings()

    src_family = scoring.get_type_family(src_col.data_type)
    tgt_family = scoring.get_type_family(tgt_col.data_type)
    if src_family != tgt_family:
        return {
            "verdict": "blocked", "reason": "type_mismatch",
            "threshold": settings.gate_distinct_ratio,
            "src": _build_gate_side(src_ref, src_col, src_family, cached=False),
            "tgt": _build_gate_side(tgt_ref, tgt_col, tgt_family, cached=False),
        }

    try:
        src_cached = _ensure_sample_stats(src_col, src_ref, validator, settings.gate_sample_top)
        tgt_cached = _ensure_sample_stats(tgt_col, tgt_ref, validator, settings.gate_sample_top)
    except ValidationDataMissing as e:
        raise HTTPException(
            404, {"message": "no value data for column", "context": {"column": str(e.ref)}}
        ) from e
    db.flush()

    src_side = _build_gate_side(src_ref, src_col, src_family, src_cached)
    tgt_side = _build_gate_side(tgt_ref, tgt_col, tgt_family, tgt_cached)
    threshold = settings.gate_distinct_ratio
    both_low = src_side["ratio"] < threshold and tgt_side["ratio"] < threshold
    return {
        "verdict": "blocked" if both_low else "pass",
        "reason": "both_low_distinct" if both_low else None,
        "threshold": threshold,
        "src": src_side, "tgt": tgt_side,
    }


@router.post("/containment")
def run_containment(
    req: ContainmentRequest,
    db: Session = Depends(get_db),
    validator: JoinValidator = Depends(get_join_validator),
) -> dict:
    """T2 — 지정 컬럼 페어 containment 검증, 결과는 영구 기록 (계획 §3.2·§3.4)."""
    src_ref, src_col = resolve_column_ref(db, req.src_column_id)
    tgt_ref, tgt_col = resolve_column_ref(db, req.tgt_column_id)
    ensure_not_hidden(src_ref, tgt_ref)

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
    ensure_not_hidden(src_ref, tgt_ref)
    # 조인 샘플도 양쪽 테이블의 실값을 내보낸다 — 테이블 미리보기와 같은 허용 목록을 쓴다
    # (여기가 열려 있으면 허용 목록이 우회된다). 검증기는 사내 MSSQL 실행기 하나뿐이라
    # 기본 소스로 판정한다 — 다른 소스의 값은 애초에 이 경로로 나올 수 없다
    blocked = [ref.object_qname for ref in (src_ref, tgt_ref)
               if not is_preview_allowed(db, MANAGED_MSSQL_SOURCE_ID,
                                         ref.object_qname.split(".", 1)[0])]
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


PAIR_CANDIDATE_LIMIT = 20  # 상위 페어 수 — UI 한 화면 분량


@router.get("/pair-candidates")
def list_pair_candidates(
    src_object_id: int,
    tgt_object_id: int,
    db: Session = Depends(get_db),
) -> dict:
    """두 테이블 간 후보 컬럼 페어 — 카탈로그 신호만, 쿼리 0회 (스펙 §컬럼 선택)."""
    src_obj = db.get(CatalogObject, src_object_id)
    tgt_obj = db.get(CatalogObject, tgt_object_id)
    if src_obj is None or tgt_obj is None:
        missing = src_object_id if src_obj is None else tgt_object_id
        raise HTTPException(404, {"message": "object not found",
                                  "context": {"object_id": missing}})
    for obj in (src_obj, tgt_obj):
        if is_schema_hidden(obj.schema):
            raise HTTPException(403, {
                "message": "this schema is hidden (HIDDEN_SCHEMAS)",
                "context": {"object": f"{obj.schema}.{obj.name}"},
            })

    settings = get_settings()
    columns = load_scoring_columns(db, src_obj.snapshot_id)
    view_pairs, fk_pairs = load_pair_sets(db, src_obj.snapshot_id)
    src_qname = f"{src_obj.schema}.{src_obj.name}"
    tgt_qname = f"{tgt_obj.schema}.{tgt_obj.name}"
    targets = [c for c in columns.values() if c.object_qname == tgt_qname]

    blacklist = {name.upper() for name in settings.low_cardinality_blacklist}
    items = []
    for src in columns.values():
        if src.object_qname != src_qname:
            continue
        for cand in scoring.score_candidates(
            src, targets, view_pairs, fk_pairs,
            settings.low_cardinality_min_distinct, blacklist,
        ):
            items.append({
                "src_column_id": src.column_id, "src_column": src.name,
                "src_data_type": src.data_type,
                "tgt_column_id": cand.target.column_id, "tgt_column": cand.target.name,
                "tgt_data_type": cand.target.data_type,
                "tgt_is_pk": cand.target.is_pk,
                "score": cand.score, "signals": cand.signals,
            })
    items.sort(key=lambda i: (-i["score"], i["src_column"], i["tgt_column"]))
    return {"items": items[:PAIR_CANDIDATE_LIMIT]}
