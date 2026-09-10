# backend/app/api/value_probe.py
"""Value probe endpoints — 202 + polling. / 값 추적 API (스캔 잡과 같은 응답 규약).

값을 읽는 경로라 미리보기와 같은 게이트를 지킨다: 숨김 스키마 → 허용 목록 → 감사 로그.
잡 행에 검색값이 있으므로 조회는 요청자 본인(또는 sysadmin)에게만 연다.
"""

import json
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, aliased, sessionmaker

from app.auth import get_current_user, is_sysadmin
from app.config import get_settings
from app.db import get_db, get_session_factory
from app.domain.value_probe import PROBE_MAX_SCHEMAS, PROBE_VALUE_MAX_LEN
from app.models import AuditLog, CatalogObject, DataSource, Snapshot, ViewLineageFlat
from app.models.value_probe import ValueProbeHit, ValueProbeJob, ValueProbeTarget
from app.services.preview_policy import is_preview_allowed
from app.services.schema_visibility import is_schema_hidden
from app.services.value_probe import RelatedViews, build_plan, find_related_views, run_startable_probe_jobs

router = APIRouter(prefix="/api/value-probe", tags=["value-probe"])

ProbeMode = Literal["normalized", "exact", "contains"]
FINISHED = ("done", "cancelled", "failed")


def get_probe_session_factory() -> sessionmaker:
    """백그라운드 러너용 세션 팩토리 — 테스트 오버라이드 지점 / DI point for tests."""
    return get_session_factory()


class ValueProbeRequest(BaseModel):
    source_id: int
    schemas: list[str] = Field(min_length=1, max_length=PROBE_MAX_SCHEMAS)
    value: str = Field(min_length=1, max_length=PROBE_VALUE_MAX_LEN)
    mode: ProbeMode = "normalized"
    hint: str | None = Field(None, max_length=128)
    # 선택 스키마 밖의 뷰(lineage로 찾은)까지 후보에 넣을지 — 기본은 끈다(기존 동작 보존)
    include_related_views: bool = False


class HeavyRequest(BaseModel):
    target_ids: list[int] = Field(min_length=1, max_length=200)


def _load_owned_job(db: Session, job_id: int, login_id: str) -> ValueProbeJob:
    job = db.get(ValueProbeJob, job_id)
    # 타인의 잡은 존재조차 알리지 않는다 — 잡 행에 검색값이 있다 / 404, not 403
    if job is None or (job.triggered_by != login_id and not is_sysadmin(login_id)):
        raise HTTPException(404, {"message": "job not found", "context": {"job_id": job_id}})
    return job


def _format_schemas(schemas: list[str]) -> str:
    head = ",".join(schemas[:10])
    return head if len(schemas) <= 10 else f"{head}+{len(schemas) - 10}"


def _latest_ready_snapshot(db: Session, source_id: int) -> Snapshot | None:
    return db.execute(
        select(Snapshot)
        .where(Snapshot.status == "ready", Snapshot.data_source_id == source_id)
        .order_by(Snapshot.id.desc()).limit(1)
    ).scalar_one_or_none()


def _check_schema_gates(db: Session, source_id: int, schemas: list[str]) -> None:
    """숨김 → 허용 목록 순 게이트 — 잡 생성 시와 heavy 승격 시(재조회) 둘 다에서 부른다.

    허용 목록은 관리자가 언제든 바꿀 수 있는 상태이고 잡 행은 무기한 남으므로, 승격 시점에도
    다시 확인해야 한다 — 그렇지 않으면 철회된 뒤에도 원본 값 쿼리가 나갈 수 있다.
    """
    for schema in schemas:
        if is_schema_hidden(schema):
            raise HTTPException(403, {
                "message": "this schema is hidden — its columns and values are not served "
                           "(HIDDEN_SCHEMAS)",
                "context": {"schema": schema},
            })
        if not is_preview_allowed(db, source_id, schema):
            raise HTTPException(403, {
                "message": "preview is not allowed for this schema — an admin must add it "
                           "to the preview allowlist (관리 콘솔 → 미리보기 허용 스키마)",
                "context": {"schema": schema},
            })


@router.post("", status_code=202)
def start_value_probe(
    req: ValueProbeRequest,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    login_id: str = Depends(get_current_user),
    session_factory: sessionmaker = Depends(get_probe_session_factory),
) -> dict:
    """잡 등록 — 카탈로그만으로 계획을 세우고 202. 실행은 백그라운드 + 폴링."""
    value = req.value.strip()
    if not value:
        raise HTTPException(400, {"message": "value is blank", "context": {}})
    source = db.get(DataSource, req.source_id)
    if source is None:
        raise HTTPException(404, {"message": "data source not found",
                                  "context": {"source_id": req.source_id}})
    if not source.is_enabled:
        raise HTTPException(409, {"message": "this data source is disabled — enable it before connecting",
                                  "context": {"source_id": source.id, "name": source.name}})
    snapshot = _latest_ready_snapshot(db, source.id)
    if snapshot is None:
        raise HTTPException(409, {"message": "no ready snapshot for this source",
                                  "context": {"source_id": source.id}})
    schemas = list(dict.fromkeys(s.strip() for s in req.schemas if s.strip()))
    if not schemas:
        raise HTTPException(400, {"message": "no schema selected", "context": {}})
    _check_schema_gates(db, source.id, schemas)

    related = (find_related_views(db, snapshot.id, schemas, source.id)
               if req.include_related_views else RelatedViews((), (), ()))
    settings = get_settings()
    targets = build_plan(db, snapshot.id, schemas, source.engine, value, req.mode, req.hint,
                         settings, extra_object_ids=related.object_ids)
    auto = [t for t in targets if t.tier == "auto"]
    if req.mode == "contains" and len(auto) > settings.value_probe_contains_max_tables:
        raise HTTPException(400, {
            "message": "contains mode needs a narrower scope",
            "context": {"auto_targets": len(auto),
                        "limit": settings.value_probe_contains_max_tables},
        })

    now = datetime.now(UTC)
    job = ValueProbeJob(
        data_source_id=source.id, snapshot_id=snapshot.id, value=value, mode=req.mode,
        hint=req.hint, schemas=json.dumps(schemas), status="queued" if auto else "done",
        progress_total=len(auto), progress_done=0, cancel_requested=False,
        triggered_by=login_id, created_at=now, finished_at=None if auto else now,
        include_related_views=req.include_related_views,
        related_schemas=json.dumps(list(related.schemas)),
        related_skipped=json.dumps(list(related.skipped)),
    )
    db.add(job)
    db.flush()
    for target in targets:
        db.add(ValueProbeTarget(
            job_id=job.id, object_id=target.object_id, qname=target.qname,
            object_type=target.object_type,
            columns=json.dumps([c.to_dict() for c in target.columns]),
            tier=target.tier, heavy_reason=target.heavy_reason, rank=target.rank,
            est_rows=target.est_rows, status="pending",
        ))
    heavy_count = len(targets) - len(auto)
    detail = (f"source={source.id} schemas={_format_schemas(schemas)} mode={req.mode} "
              f"value='{value}' targets auto={len(auto)} heavy={heavy_count}")
    if req.include_related_views:
        detail += f" related_views=+{len(related.object_ids)}/-{len(related.skipped)}"
    db.add(AuditLog(
        action="value_probe", detail=detail[:600],
        requested_by=login_id, requested_at=now,
    ))
    db.flush()
    if auto:
        background.add_task(run_startable_probe_jobs, session_factory, settings)
    return {
        "job_id": job.id, "status": job.status,
        "plan": {"auto": len(auto), "heavy": heavy_count,
                 "columns": sum(len(t.columns) for t in targets),
                 "related_views": {"included": len(related.object_ids),
                                    "skipped": list(related.skipped)}},
    }


def _load_lineage(
    db: Session, snapshot_id: int, hits: list[ValueProbeHit],
) -> tuple[dict[tuple[int, str], list[str]], dict[tuple[int, str], dict]]:
    """테이블 히트를 direct로 노출하는 뷰 목록, 뷰 파생 히트의 원본 — MSSQL lineage에서만 채워진다."""
    exposed: dict[tuple[int, str], list[str]] = {}
    derived: dict[tuple[int, str], dict] = {}
    view_obj = aliased(CatalogObject)
    base_obj = aliased(CatalogObject)
    table_ids = {hit.object_id for hit in hits if hit.object_type == "table"}
    if table_ids:
        rows = db.execute(
            select(ViewLineageFlat.base_object_id, ViewLineageFlat.base_column,
                   view_obj.schema, view_obj.name)
            .join(view_obj, view_obj.id == ViewLineageFlat.view_object_id)
            .where(ViewLineageFlat.snapshot_id == snapshot_id,
                   ViewLineageFlat.mapping_kind == "direct",
                   ViewLineageFlat.base_object_id.in_(table_ids))
            .order_by(view_obj.schema, view_obj.name)
        ).all()
        for base_id, base_column, schema, name in rows:
            bucket = exposed.setdefault((base_id, base_column), [])
            qname = f"{schema}.{name}"
            if qname not in bucket:
                bucket.append(qname)
    view_ids = {hit.object_id for hit in hits if hit.object_type == "view"}
    if view_ids:
        rows = db.execute(
            select(ViewLineageFlat.view_object_id, ViewLineageFlat.view_column,
                   base_obj.schema, base_obj.name, ViewLineageFlat.base_column)
            .join(base_obj, base_obj.id == ViewLineageFlat.base_object_id)
            .where(ViewLineageFlat.snapshot_id == snapshot_id,
                   ViewLineageFlat.mapping_kind == "derived",
                   ViewLineageFlat.view_object_id.in_(view_ids))
        ).all()
        for view_id, view_column, schema, name, base_column in rows:
            derived.setdefault((view_id, view_column),
                               {"qname": f"{schema}.{name}", "column": base_column})
    return exposed, derived


@router.get("/{job_id}")
def get_value_probe_job(
    job_id: int,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    login_id: str = Depends(get_current_user),
    session_factory: sessionmaker = Depends(get_probe_session_factory),
) -> dict:
    """진행률 폴링 — 진행 중에도 히트를 돌려준다. 폴링이 큐 기동도 겸한다(스캔과 동일)."""
    job = _load_owned_job(db, job_id, login_id)
    targets = db.execute(
        select(ValueProbeTarget).where(ValueProbeTarget.job_id == job.id)
        .order_by(ValueProbeTarget.rank)
    ).scalars().all()
    hits = db.execute(
        select(ValueProbeHit).where(ValueProbeHit.job_id == job.id).order_by(ValueProbeHit.id)
    ).scalars().all()
    exposed, derived = _load_lineage(db, job.snapshot_id, hits)
    background.add_task(run_startable_probe_jobs, session_factory, get_settings())
    return {
        "job_id": job.id, "status": job.status,
        "progress": {"done": job.progress_done, "total": job.progress_total},
        "error": job.error, "current_qname": job.current_qname,
        "value": job.value, "mode": job.mode, "schemas": json.loads(job.schemas),
        "source_id": job.data_source_id,
        "include_related_views": job.include_related_views,
        "related_schemas": json.loads(job.related_schemas or "[]"),
        "related_view_skipped": json.loads(job.related_skipped or "[]"),
        "hits": [
            {
                "object_id": hit.object_id, "qname": hit.qname, "object_type": hit.object_type,
                "column": hit.column_name, "match_count": hit.match_count,
                "count_capped": hit.count_capped, "matched_variant": hit.matched_variant,
                "exposed_by_views": exposed.get((hit.object_id, hit.column_name), []),
                "derived_from": derived.get((hit.object_id, hit.column_name)),
            }
            for hit in hits
        ],
        "heavy": [
            {"target_id": t.id, "qname": t.qname, "est_rows": t.est_rows,
             "reason": t.heavy_reason}
            for t in targets if t.tier == "heavy"
        ],
        "failed_targets": [
            {"qname": t.qname, "status": t.status, "error": t.error}
            for t in targets if t.status in ("error", "timeout")
        ],
    }


@router.post("/{job_id}/heavy")
def run_heavy_targets(
    job_id: int,
    req: HeavyRequest,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    login_id: str = Depends(get_current_user),
    session_factory: sessionmaker = Depends(get_probe_session_factory),
) -> dict:
    """선택한 heavy 대상만 auto로 승격해 이어서 실행 — 사용자의 명시적 선택이 비용 승인이다."""
    job = _load_owned_job(db, job_id, login_id)
    if job.status == "running":
        raise HTTPException(409, {
            "message": "job is still running — wait for it to finish before promoting heavy "
                       "targets",
            "context": {"job_id": job.id, "status": job.status},
        })
    # 허용 목록은 잡 생성 후 관리자가 철회했을 수 있다 — 승격 시점에 다시 확인한다(연관 뷰 스키마 포함)
    _check_schema_gates(db, job.data_source_id,
                        json.loads(job.schemas) + json.loads(job.related_schemas or "[]"))
    wanted = set(req.target_ids)
    targets = db.execute(
        select(ValueProbeTarget)
        .where(ValueProbeTarget.job_id == job.id, ValueProbeTarget.id.in_(wanted))
    ).scalars().all()
    if len(targets) != len(wanted) or any(t.tier != "heavy" for t in targets):
        raise HTTPException(400, {"message": "target is not a heavy target of this job",
                                  "context": {"job_id": job.id}})
    now = datetime.now(UTC)
    for target in targets:
        target.tier = "auto"
        target.status = "pending"
        target.error = None
    job.progress_total += len(targets)
    if job.status in FINISHED:
        job.status = "queued"
        job.cancel_requested = False
        job.finished_at = None
        job.error = None
    db.add(AuditLog(
        action="value_probe_heavy",
        detail=(f"job={job.id} source={job.data_source_id} "
                f"targets={','.join(t.qname for t in targets)}")[:600],
        requested_by=login_id, requested_at=now,
    ))
    db.flush()
    background.add_task(run_startable_probe_jobs, session_factory, get_settings())
    return {"job_id": job.id, "status": job.status, "promoted": len(targets)}


@router.post("/{job_id}/cancel")
def cancel_value_probe(
    job_id: int,
    db: Session = Depends(get_db),
    login_id: str = Depends(get_current_user),
) -> dict:
    """취소 — 대기 중이면 즉시, 실행 중이면 러너가 다음 대상 전에 멈춘다."""
    job = _load_owned_job(db, job_id, login_id)
    if job.status == "queued":
        job.status = "cancelled"
        job.finished_at = datetime.now(UTC)
    elif job.status == "running":
        job.cancel_requested = True
    return {"job_id": job.id, "status": job.status}
