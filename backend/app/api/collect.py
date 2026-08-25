"""Button-triggered collection — stepwise or full, 202 + polling. / 버튼 트리거 수집 API."""

import json
import time
from datetime import UTC, datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.adapters import create_collect_runner
from app.adapters.collect_runner import CollectRunner
from app.auth import require_sysadmin
from app.config import get_settings
from app.db import get_db, get_session_factory
from app.models import CollectJob, Snapshot

router = APIRouter(
    prefix="/api/collect", tags=["collect"], dependencies=[Depends(require_sysadmin)]
)

# full 모드 체인 대기 상한·폴링 간격(초) — n8n 경로는 ingest 콜백을 기다린다
# chain wait bounds for full mode; the n8n path waits on the ingest callback
CHAIN_TIMEOUT = 900
CHAIN_POLL_INTERVAL = 2.0


def get_collect_session_factory() -> sessionmaker:
    """배경 작업용 세션 팩토리 — 테스트가 오버라이드하는 DI 지점 (scan과 동일 패턴)."""
    return get_session_factory()


def get_collect_runner() -> CollectRunner:
    """설정 기반 러너(기본 소스) — 테스트는 이 의존성을 오버라이드한다 / DI point for tests."""
    return create_collect_runner(get_settings(), get_session_factory())


def get_collect_runner_for(
    source_id: int | None, db: Session, session_factory: sessionmaker,
) -> CollectRunner:
    """요청이 지정한 소스의 러너 — source_id 없으면 기본(사내 MSSQL)과 동일하게 라우팅된다.

    session_factory는 호출부의 Depends(get_collect_session_factory) 결과를 그대로 받는다 —
    여기서 get_session_factory()를 새로 부르면 테스트가 오버라이드한 세션 팩토리를 우회해
    실제 서비스 DB로 적재해버린다.
    """
    from app.sources.registry import get_source

    source = get_source(db, source_id)
    # 배경 작업은 요청의 db 세션이 커밋·종료된 뒤에 실행된다 — expunge하지 않으면 커밋이
    # 만료시킨 속성을 다시 읽으려다 "not bound to a Session"으로 죽는다
    db.expunge(source)
    return create_collect_runner(get_settings(), session_factory, source)


class TriggerRequest(BaseModel):
    triggered_by: str = "local"
    source_id: int | None = None


class StepRequest(BaseModel):
    job_id: int
    triggered_by: str = "local"
    source_id: int | None = None


def _create_job(db: Session, mode: str, triggered_by: str) -> CollectJob:
    now = datetime.now(UTC)
    job = CollectJob(mode=mode, stage="catalog_running",
                     triggered_by=triggered_by, created_at=now, updated_at=now)
    db.add(job)
    db.flush()
    return job


def _is_direct_source_job(db: Session, job: CollectJob) -> bool:
    """이 잡의 스냅샷이 direct 소스에 속하는가 — direct 소스는 뷰 의존 단계가 없어
    run_catalog가 catalog_done을 거치지 않고 곧장 ready로 끝난다(direct_runner.py)."""
    if job.snapshot_id is None:
        return False
    from app.sources.registry import get_source

    snapshot = db.get(Snapshot, job.snapshot_id)
    if snapshot is None:
        return False
    return get_source(db, snapshot.data_source_id).access_mode == "direct"


def _mark_failed(session_factory: sessionmaker, job_id: int, error: str) -> None:
    with session_factory() as db:
        job = db.get(CollectJob, job_id)
        if job is not None:
            job.stage = "failed"
            job.error = error
            job.updated_at = datetime.now(UTC)
            db.commit()


def _run_catalog_step(session_factory: sessionmaker, runner: CollectRunner, job_id: int) -> None:
    try:
        runner.run_catalog(job_id)
    except Exception as e:  # 배경 작업 — 실패는 잡에 격리 / isolate failures on the job
        _mark_failed(session_factory, job_id, f"catalog step failed: {e}")


def _run_deps_step(
    session_factory: sessionmaker, runner: CollectRunner, job_id: int, snapshot_id: int,
) -> None:
    try:
        runner.run_view_deps(job_id, snapshot_id)
    except Exception as e:
        _mark_failed(session_factory, job_id, f"view-deps step failed: {e}")


def _run_full(session_factory: sessionmaker, runner: CollectRunner, job_id: int) -> None:
    """카탈로그 → (콜백 대기) → 뷰 의존 체인 / catalog, wait for callback, then deps."""
    try:
        runner.run_catalog(job_id)
    except Exception as e:
        _mark_failed(session_factory, job_id, f"catalog step failed: {e}")
        return

    deadline = time.monotonic() + CHAIN_TIMEOUT
    snapshot_id: int | None = None
    while time.monotonic() < deadline:
        with session_factory() as db:
            job = db.get(CollectJob, job_id)
            # direct 소스는 뷰 의존 단계가 없어 run_catalog가 곧장 'ready'로 마감한다 —
            # 'catalog_done'을 영원히 기다리다 15분 뒤 오탐으로 failed 처리되면 안 된다
            if job is None or job.stage in ("failed", "ready"):
                return
            if job.stage == "catalog_done" and job.snapshot_id is not None:
                snapshot_id = job.snapshot_id
                job.stage = "deps_running"
                job.updated_at = datetime.now(UTC)
                db.commit()
                break
        time.sleep(CHAIN_POLL_INTERVAL)
    if snapshot_id is None:
        _mark_failed(session_factory, job_id, "catalog step did not complete in time")
        return
    _run_deps_step(session_factory, runner, job_id, snapshot_id)


def _job_payload(job: CollectJob) -> dict:
    return {
        "job_id": job.id, "mode": job.mode, "stage": job.stage,
        "snapshot_id": job.snapshot_id,
        "counts": json.loads(job.counts) if job.counts else {},
        "triggered_by": job.triggered_by, "error": job.error,
        "created_at": job.created_at.isoformat(),
        "updated_at": job.updated_at.isoformat(),
    }


@router.post("/catalog", status_code=202)
def trigger_catalog_step(
    req: TriggerRequest,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    runner: CollectRunner = Depends(get_collect_runner),
    session_factory: sessionmaker = Depends(get_collect_session_factory),
) -> dict:
    """1단계 — 카탈로그 수집(객체·컬럼·키·FK·뷰 정의) 트리거."""
    if req.source_id is not None:
        runner = get_collect_runner_for(req.source_id, db, session_factory)
    job = _create_job(db, "step", req.triggered_by)
    background.add_task(_run_catalog_step, session_factory, runner, job.id)
    return _job_payload(job)


@router.post("/view-deps", status_code=202)
def trigger_view_deps_step(
    req: StepRequest,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    runner: CollectRunner = Depends(get_collect_runner),
    session_factory: sessionmaker = Depends(get_collect_session_factory),
) -> dict:
    """2단계 — 뷰 의존 수집 + lineage·파싱. 1단계 완료(catalog_done)가 선행 조건.

    direct 소스 잡은 catalog_done을 거치지 않고 run_catalog에서 곧장 ready로 끝난다 —
    그런 잡에 이 엔드포인트를 불러도 "카탈로그가 안 끝났다"는 거짓 409 대신, 이미 끝난
    상태를 그대로 돌려주는 멱등한 no-op으로 응답한다. non-direct 소스는 기존 409 그대로.
    """
    if req.source_id is not None:
        runner = get_collect_runner_for(req.source_id, db, session_factory)
    job = db.get(CollectJob, req.job_id)
    if job is None:
        raise HTTPException(404, {"message": "collect job not found",
                                  "context": {"job_id": req.job_id}})
    if job.stage == "ready" and _is_direct_source_job(db, job):
        return _job_payload(job)
    if job.stage != "catalog_done" or job.snapshot_id is None:
        raise HTTPException(409, {
            "message": "catalog step must complete before view-deps",
            "context": {"job_id": job.id, "stage": job.stage},
        })
    job.stage = "deps_running"
    job.updated_at = datetime.now(UTC)
    background.add_task(_run_deps_step, session_factory, runner, job.id, job.snapshot_id)
    return _job_payload(job)


@router.post("/full", status_code=202)
def trigger_full_collection(
    req: TriggerRequest,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    runner: CollectRunner = Depends(get_collect_runner),
    session_factory: sessionmaker = Depends(get_collect_session_factory),
) -> dict:
    """전체 실행 — 카탈로그 → 뷰 의존을 자동 체인."""
    if req.source_id is not None:
        runner = get_collect_runner_for(req.source_id, db, session_factory)
    job = _create_job(db, "full", req.triggered_by)
    background.add_task(_run_full, session_factory, runner, job.id)
    return _job_payload(job)


# 진행 중으로 간주하는 단계 — UI가 새 수집을 막는 기준과 같다 / stages the UI treats as busy
RUNNING_STAGES = ("catalog_running", "deps_running")


@router.post("/jobs/{job_id}/cancel")
def cancel_collect_job(
    job_id: int,
    db: Session = Depends(get_db),
    admin: str = Depends(require_sysadmin),
) -> dict:
    """멈춘 잡을 실패로 닫는다 — n8n 실행이 죽어도 잡은 남아 새 수집을 막기 때문.

    n8n 쪽 실행을 되돌리지는 않는다(되돌릴 방법이 없다) — 잡 상태만 해제한다.
    Closes a stuck job so a new collection can start; does not abort the n8n run.
    """
    job = db.get(CollectJob, job_id)
    if job is None:
        raise HTTPException(404, {"message": "collect job not found",
                                  "context": {"job_id": job_id}})
    if job.stage not in RUNNING_STAGES:
        raise HTTPException(409, {"message": "job is not running",
                                  "context": {"job_id": job_id, "stage": job.stage}})
    job.stage = "failed"
    job.error = f"cancelled by {admin}"
    job.updated_at = datetime.now(UTC)
    return _job_payload(job)


@router.get("/jobs/{job_id}")
def get_collect_job(job_id: int, db: Session = Depends(get_db)) -> dict:
    job = db.get(CollectJob, job_id)
    if job is None:
        raise HTTPException(404, {"message": "collect job not found",
                                  "context": {"job_id": job_id}})
    return _job_payload(job)


@router.get("/jobs")
def list_collect_jobs(limit: int = 10, db: Session = Depends(get_db)) -> dict:
    jobs = db.execute(
        select(CollectJob).order_by(CollectJob.id.desc()).limit(min(limit, 50))
    ).scalars().all()
    return {"items": [_job_payload(j) for j in jobs]}
