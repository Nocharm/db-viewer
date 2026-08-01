"""T3 scan endpoints — 202 + progress polling. / 탐색 스캔 API (계획 Phase 4, 승인 응답 규약)."""

from datetime import UTC, datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.api.validate import get_join_validator, resolve_column_ref
from app.config import get_settings
from app.db import get_db, get_session_factory
from app.domain import scoring
from app.domain.scheduling import compute_not_before
from app.domain.validation import JoinValidator
from app.models import CatalogObject, ScanJob, ScanResult
from app.services.scan import run_startable_jobs

router = APIRouter(tags=["scan"])


def get_scan_session_factory() -> sessionmaker:
    """백그라운드 작업용 세션 팩토리 — 테스트 오버라이드 지점 / DI point for tests."""
    return get_session_factory()


class ScanRequest(BaseModel):
    column_id: int
    night_only: bool = False
    triggered_by: str = "local"


@router.post("/api/scan", status_code=202)
def start_scan(
    req: ScanRequest,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    validator: JoinValidator = Depends(get_join_validator),
    session_factory: sessionmaker = Depends(get_scan_session_factory),
) -> dict:
    """스캔 잡 등록 — 동기 실행 금지, 202 + 폴링 (계획 §4)."""
    src_ref, src_col = resolve_column_ref(db, req.column_id)
    obj = db.get(CatalogObject, src_col.object_id)

    settings = get_settings()
    src = scoring.ScoringColumn(
        column_id=src_col.id, object_qname=src_ref.object_qname, object_type=obj.type,
        name=src_col.name, data_type=src_col.data_type, max_length=src_col.max_length,
        is_pk=src_col.is_pk, is_computed=src_col.is_computed,
        distinct_count=src_col.distinct_count,
    )
    exclusion = scoring.check_exclusion(
        src, settings.low_cardinality_min_distinct,
        {name.upper() for name in settings.low_cardinality_blacklist},
    )
    if exclusion is not None:
        raise HTTPException(400, {
            "message": "column is excluded from validation",
            "context": {"column": str(src_ref), "reason": exclusion},
        })

    now = datetime.now(UTC)
    job = ScanJob(
        src_object=src_ref.object_qname, src_column=src_ref.column,
        status="queued", progress_total=0, progress_done=0,
        night_only=req.night_only,
        not_before=compute_not_before(
            now, req.night_only,
            settings.scan_night_start_hour, settings.scan_night_end_hour,
        ),
        triggered_by=req.triggered_by, created_at=now,
    )
    db.add(job)
    db.flush()
    background.add_task(run_startable_jobs, session_factory, validator, settings)
    return {
        "job_id": job.id, "status": job.status,
        "not_before": job.not_before.isoformat() if job.not_before else None,
    }


@router.get("/api/jobs/{job_id}")
def get_job(
    job_id: int,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    validator: JoinValidator = Depends(get_join_validator),
    session_factory: sessionmaker = Depends(get_scan_session_factory),
) -> dict:
    """진행률 폴링 — 폴링이 야간 창 진입 시 큐 기동도 겸한다 / polling also kicks the queue."""
    job = db.get(ScanJob, job_id)
    if job is None:
        raise HTTPException(404, {"message": "job not found", "context": {"job_id": job_id}})

    results = []
    if job.status == "done":
        results = [
            {
                "rank": r.rank, "tgt_object": r.tgt_object, "tgt_column": r.tgt_column,
                "containment_sample": r.containment_sample,
                "containment_full": r.containment_full, "cardinality": r.cardinality,
            }
            for r in db.execute(
                select(ScanResult).where(ScanResult.job_id == job.id)
                .order_by(ScanResult.rank)
            ).scalars()
        ]
    background.add_task(run_startable_jobs, session_factory, validator, get_settings())
    return {
        "job_id": job.id, "status": job.status,
        "progress": {"done": job.progress_done, "total": job.progress_total},
        "error": job.error,
        "results": results,
    }
