"""Table-level join validation — batch T2 over top candidate pairs. / 테이블 단위 조인 검증."""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.validate import get_join_validator
from app.config import get_settings
from app.db import get_db
from app.domain import scoring
from app.domain.validation import ColumnRef, JoinValidator, ValidationDataMissing
from app.models import CatalogColumn, CatalogObject
from app.services.catalog_queries import load_pair_sets, load_scoring_columns
from app.services.observations import record_observation

router = APIRouter(prefix="/api/objects", tags=["objects"])

# 일괄 검증 타깃 상한 — T2는 원본 질의라 비용 상한 필수 / hard cap on batch targets
BATCH_TARGET_LIMIT = 8


class JoinCheckRequest(BaseModel):
    # 지정 시 해당 테이블만, 미지정 시 상위 후보 테이블 일괄 / one target or top-N batch
    target_object_id: int | None = None
    triggered_by: str = "table_check"


def _ref_from_scoring(col: scoring.ScoringColumn) -> ColumnRef:
    schema, name = col.object_qname.split(".", 1)
    return ColumnRef(schema, name, col.name)


def select_target_pairs(
    columns: dict[int, scoring.ScoringColumn],
    src_object_qname: str,
    view_pairs: set[frozenset],
    fk_pairs: set[frozenset],
    min_distinct: int,
    blacklist: set[str],
    target_qname: str | None,
) -> list[tuple[scoring.ScoringColumn, scoring.Candidate]]:
    """타깃 테이블별 최고 점수 컬럼 페어 1건씩 선별 / best-scored pair per target table."""
    best: dict[str, tuple[scoring.ScoringColumn, scoring.Candidate]] = {}
    all_columns = list(columns.values())
    for src in all_columns:
        if src.object_qname != src_object_qname:
            continue
        if scoring.check_exclusion(src, min_distinct, blacklist) is not None:
            continue
        for cand in scoring.score_candidates(
            src, all_columns, view_pairs, fk_pairs, min_distinct, blacklist
        ):
            tgt_qname = cand.target.object_qname
            if tgt_qname == src_object_qname:
                continue
            if target_qname is not None and tgt_qname != target_qname:
                continue
            if tgt_qname not in best or cand.score > best[tgt_qname][1].score:
                best[tgt_qname] = (src, cand)
    ranked = sorted(best.values(), key=lambda pair: -pair[1].score)
    return ranked if target_qname is not None else ranked[:BATCH_TARGET_LIMIT]


@router.post("/{object_id}/join-check")
def run_join_check(
    object_id: int,
    req: JoinCheckRequest,
    db: Session = Depends(get_db),
    validator: JoinValidator = Depends(get_join_validator),
) -> dict:
    """소스 테이블의 타깃별 최고 후보 페어에 T2 containment 일괄 실행 (계획 §3 준용)."""
    obj = db.get(CatalogObject, object_id)
    if obj is None:
        raise HTTPException(404, {"message": "object not found",
                                  "context": {"object_id": object_id}})
    if obj.type != "table":
        raise HTTPException(400, {"message": "join check runs on tables only",
                                  "context": {"object_id": object_id, "type": obj.type}})
    src_qname = f"{obj.schema}.{obj.name}"

    target_qname = None
    if req.target_object_id is not None:
        target = db.get(CatalogObject, req.target_object_id)
        if target is None or target.type != "table":
            raise HTTPException(404, {"message": "target table not found",
                                      "context": {"target_object_id": req.target_object_id}})
        target_qname = f"{target.schema}.{target.name}"

    settings = get_settings()
    blacklist = {name.upper() for name in settings.low_cardinality_blacklist}
    columns = load_scoring_columns(db, obj.snapshot_id)
    view_pairs, fk_pairs = load_pair_sets(db, obj.snapshot_id)
    pairs = select_target_pairs(
        columns, src_qname, view_pairs, fk_pairs,
        settings.low_cardinality_min_distinct, blacklist, target_qname,
    )

    now = datetime.now(UTC)
    results = []
    for src_col, cand in pairs:
        src_ref = _ref_from_scoring(src_col)
        tgt_ref = _ref_from_scoring(cand.target)
        item = {
            "target_object": cand.target.object_qname,
            "src_column": src_col.name, "tgt_column": cand.target.name,
            "score": cand.score, "signals": cand.signals,
        }
        try:
            result = validator.containment(src_ref, tgt_ref)
        except ValidationDataMissing:
            # 값 데이터 없는 페어는 배치를 죽이지 않고 표시만 / no-data marks, not failures
            item["status"] = "no_data"
            results.append(item)
            continue
        # 관측치로 컬럼 통계 채움 — /containment와 동일 규약 (계획 §1.2·§3.3)
        db.get(CatalogColumn, src_col.column_id).distinct_count = result.src_distinct
        db.get(CatalogColumn, cand.target.column_id).distinct_count = result.tgt_distinct
        conf = record_observation(db, src_ref, tgt_ref, result, req.triggered_by, now)
        item.update({
            "status": "checked",
            "containment": result.containment, "orphan_count": result.orphan_count,
            "cardinality": result.cardinality,
            "confidence": conf.confidence, "pattern": conf.pattern,
        })
        results.append(item)

    checked = [r for r in results if r["status"] == "checked"]
    checked.sort(key=lambda r: -r["containment"])
    no_data = [r for r in results if r["status"] == "no_data"]
    return {
        "object": src_qname,
        "target": target_qname,
        "checked": checked,
        "no_data": no_data,
        "observed_at": now.isoformat(),
    }
