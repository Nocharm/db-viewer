# backend/app/services/value_probe.py
"""Value probe — catalog plan + background execution. / 값 추적 계획·실행.

계획은 카탈로그만 읽고(쿼리 0), 실행은 대상마다 프로브 1개 + 히트 컬럼당 건수 1개다.
대상 하나의 실패는 그 대상에만 기록하고 잡은 계속한다 — 스캔 러너와 같은 골격.
"""

import json
import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.exc import DBAPIError, DisconnectionError
from sqlalchemy.exc import TimeoutError as SATimeoutError
from sqlalchemy.orm import Session, aliased, sessionmaker

from app.adapters import create_value_prober
from app.adapters.n8n_query import N8nQueryError
from app.config import Settings
from app.domain import value_probe as domain
from app.models import CatalogColumn, CatalogObject, DataSource, ViewLineageFlat
from app.models.value_probe import ValueProbeHit, ValueProbeJob, ValueProbeTarget
from app.services.schema_visibility import get_hidden_schemas

logger = logging.getLogger(__name__)

# 대상 단위로 격리하는 소스 오류 — 조립 버그(CompileError 등)는 잡 전체를 failed로 드러낸다
SOURCE_ERRORS = (DBAPIError, SATimeoutError, DisconnectionError, N8nQueryError)


def load_probe_catalog(
    db: Session, snapshot_id: int, schemas: list[str],
) -> tuple[list[domain.ProbeCatalogColumn], dict[int, domain.ProbeCatalogObject]]:
    """선택 스키마의 객체·컬럼 + 뷰 lineage(direct 컬럼 집합, 베이스 행 수)."""
    hidden = get_hidden_schemas()
    wanted = [schema for schema in schemas if schema.lower() not in hidden]
    if not wanted:
        return [], {}
    objects = db.execute(
        select(CatalogObject)
        .where(CatalogObject.snapshot_id == snapshot_id, CatalogObject.schema.in_(wanted))
        .order_by(CatalogObject.schema, CatalogObject.name)
    ).scalars().all()
    if not objects:
        return [], {}

    view_obj = aliased(CatalogObject)
    direct: set[tuple[int, str]] = set()
    base_counts: dict[int, list[int | None]] = {}
    lineage_rows = db.execute(
        select(ViewLineageFlat.view_object_id, ViewLineageFlat.view_column,
               ViewLineageFlat.mapping_kind, CatalogObject.row_count)
        .join(view_obj, view_obj.id == ViewLineageFlat.view_object_id)
        .join(CatalogObject, CatalogObject.id == ViewLineageFlat.base_object_id, isouter=True)
        .where(ViewLineageFlat.snapshot_id == snapshot_id, view_obj.schema.in_(wanted))
    ).all()
    for view_id, view_column, kind, row_count in lineage_rows:
        if kind == "direct":
            direct.add((view_id, view_column))
        base_counts.setdefault(view_id, []).append(row_count)

    column_rows = db.execute(
        select(CatalogColumn)
        .join(CatalogObject, CatalogColumn.object_id == CatalogObject.id)
        .where(CatalogObject.snapshot_id == snapshot_id, CatalogObject.schema.in_(wanted))
        .order_by(CatalogColumn.object_id, CatalogColumn.ordinal)
    ).scalars().all()
    columns = [
        domain.ProbeCatalogColumn(
            object_id=col.object_id, name=col.name, data_type=col.data_type,
            max_length=col.max_length, distinct_count=col.distinct_count,
            masking_policy=col.masking_policy,
            has_direct_lineage=(col.object_id, col.name) in direct,
        )
        for col in column_rows
    ]
    catalog = {
        obj.id: domain.ProbeCatalogObject(
            object_id=obj.id, qname=f"{obj.schema}.{obj.name}", object_type=obj.type,
            row_count=obj.row_count, definition=obj.definition,
            base_row_counts=tuple(base_counts.get(obj.id, ())),
        )
        for obj in objects
    }
    return columns, catalog


def build_plan(
    db: Session, snapshot_id: int, schemas: list[str], engine: str,
    value: str, mode: str, hint: str | None, settings: Settings,
) -> list[domain.PlannedTarget]:
    """요청 하나의 대상 목록 — 쿼리 없이 카탈로그만으로 만든다."""
    interp = domain.interpret_value(value, mode)
    columns, catalog = load_probe_catalog(db, snapshot_id, schemas)
    blacklist = {name.upper() for name in settings.low_cardinality_blacklist}
    candidates = domain.select_candidate_columns(
        columns, interp, engine, mode, settings.low_cardinality_min_distinct, blacklist,
    )
    return domain.plan_targets(candidates, catalog, hint, settings.value_probe_heavy_rows)


def run_startable_probe_jobs(session_factory: sessionmaker, settings: Settings) -> None:
    """큐에서 기동 가능한 잡을 순차 실행 — 동시 실행 수 제한 (scan 러너와 동일 골격)."""
    while True:
        now = datetime.now(UTC)
        with session_factory() as db:
            running = len(db.execute(
                select(ValueProbeJob.id).where(ValueProbeJob.status == "running")
            ).all())
            if running >= settings.value_probe_max_concurrent:
                return
            job = db.execute(
                select(ValueProbeJob).where(ValueProbeJob.status == "queued")
                .order_by(ValueProbeJob.id)
            ).scalars().first()
            if job is None:
                return
            job.status = "running"
            job.started_at = job.started_at or now
            db.commit()
            job_id = job.id
        try:
            _execute_probe(job_id, session_factory, settings)
        except Exception as e:  # 백그라운드 격리 — 잡에 기록하고 계속 / isolate, record, continue
            logger.exception("value probe job %s failed", job_id)
            with session_factory() as db:
                job = db.get(ValueProbeJob, job_id)
                job.status = "failed"
                # 드라이버 원문(접속 계정·값)이 섞일 수 있어 예외 클래스명만 남긴다
                job.error = type(e).__name__
                job.current_qname = None
                job.finished_at = datetime.now(UTC)
                db.commit()


def _classify_error(error: Exception) -> tuple[str, str]:
    """(대상 상태, 기록 문자열) — n8n 오류는 진단 문구를, SQLAlchemy 오류는 클래스명만."""
    is_timeout = isinstance(error, SATimeoutError) or "timeout" in str(error).lower()
    status = "timeout" if is_timeout else "error"
    if isinstance(error, N8nQueryError):
        return status, str(error)[:200]
    return status, type(error).__name__[:200]


def _probe_target(prober, schema: str, name: str, columns: list[domain.ProbeColumn],
                  skip_count: bool) -> tuple[str, str | None, list[tuple[str, str, int | None, bool]]]:
    """대상 하나 실행 — (상태, 오류, [(컬럼, 변형값, 건수, 상한여부)])."""
    try:
        rows = prober.probe(schema, name, columns)
    except SOURCE_ERRORS as e:
        status, text = _classify_error(e)
        return status, text, []
    if not rows:
        return "done", None, []
    hits: list[tuple[str, str, int | None, bool]] = []
    for matched in domain.match_columns(rows[0], columns):
        column = next(c for c in columns if c.name == matched.name)
        count: int | None = None
        if not skip_count:
            try:
                count = prober.count(schema, name, column, domain.PROBE_COUNT_CAP)
            except SOURCE_ERRORS:
                logger.warning("value probe count failed", extra={"object": f"{schema}.{name}",
                                                                   "column": column.name})
            if count == 0:
                continue  # 행은 다른 컬럼 때문에 왔고 이 컬럼은 SQL상 불일치 / SQL disagrees
        capped = count is not None and count > domain.PROBE_COUNT_CAP
        hits.append((matched.name, matched.matched_variant,
                     domain.PROBE_COUNT_CAP if capped else count, capped))
    return "done", None, hits


def _execute_probe(job_id: int, session_factory: sessionmaker, settings: Settings) -> None:
    with session_factory() as db:
        job = db.get(ValueProbeJob, job_id)
        source = db.get(DataSource, job.data_source_id)
        if source is None or not source.is_enabled:
            raise RuntimeError("data source unavailable")
        target_ids = list(db.execute(
            select(ValueProbeTarget.id)
            .where(ValueProbeTarget.job_id == job_id, ValueProbeTarget.tier == "auto",
                   ValueProbeTarget.status == "pending")
            .order_by(ValueProbeTarget.rank)
        ).scalars())
        # 소스 준비 실패(합성 거부·키 미설정·미지원 엔진)는 잡 전체의 failed로 드러난다
        prober = create_value_prober(settings, source)

    for target_id in target_ids:
        with session_factory() as db:
            job = db.get(ValueProbeJob, job_id)
            if job.cancel_requested:
                job.status = "cancelled"
                job.current_qname = None
                job.finished_at = datetime.now(UTC)
                db.commit()
                return
            target = db.get(ValueProbeTarget, target_id)
            job.current_qname = target.qname
            db.commit()
            schema, name = target.qname.split(".", 1)
            columns = [domain.ProbeColumn.from_dict(d) for d in json.loads(target.columns)]
            skip_count = target.heavy_reason is not None
            object_id, object_type, qname = target.object_id, target.object_type, target.qname

        status, error, hits = _probe_target(prober, schema, name, columns, skip_count)

        with session_factory() as db:
            job = db.get(ValueProbeJob, job_id)
            target = db.get(ValueProbeTarget, target_id)
            target.status = status
            target.error = error
            for column_name, variant, count, capped in hits:
                db.add(ValueProbeHit(
                    job_id=job_id, target_id=target_id, object_id=object_id,
                    object_type=object_type, qname=qname, column_name=column_name,
                    match_count=count, count_capped=capped, matched_variant=variant[:100],
                ))
            job.progress_done += 1
            db.commit()

    with session_factory() as db:
        job = db.get(ValueProbeJob, job_id)
        job.status = "done"
        job.current_qname = None
        job.finished_at = datetime.now(UTC)
        db.commit()
