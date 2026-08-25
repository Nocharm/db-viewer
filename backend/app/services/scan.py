"""T3 exploratory scan execution. / 탐색 스캔 실행 (계획 Phase 4).

백그라운드 + 진행률 폴링. 1차 리콜(라이브에선 TABLESAMPLE) → 상위 후보만 풀 재검증.
샘플 결과는 확정으로 쓰지 않는다 — containment는 샘플링에 취약하다.
Two-pass: coarse recall then full recheck of the top; sample numbers are
never treated as final.
"""

import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.config import Settings
from app.domain import scoring
from app.domain.validation import ColumnRef, JoinValidator, ValidationDataMissing
from app.models import ScanJob, ScanResult, Snapshot
from app.models.sources import MANAGED_MSSQL_SOURCE_ID
from app.services.catalog_queries import load_scoring_columns
from app.services.observations import record_observation

logger = logging.getLogger(__name__)

_PROGRESS_COMMIT_EVERY = 25  # 진행률 커밋 주기 / progress visibility interval


def _to_ref(qname: str, column: str) -> ColumnRef:
    schema, table = qname.split(".", 1)
    return ColumnRef(schema, table, column)


def run_startable_jobs(
    session_factory: sessionmaker, validator: JoinValidator, settings: Settings
) -> None:
    """큐에서 기동 가능한 작업을 순차 실행 — 동시 실행 수 제한 (계획 §4)."""
    while True:
        now = datetime.now(UTC)
        with session_factory() as db:
            running = len(db.execute(
                select(ScanJob.id).where(ScanJob.status == "running")
            ).all())
            if running >= settings.scan_max_concurrent:
                return
            job = db.execute(
                select(ScanJob)
                .where(ScanJob.status == "queued")
                .order_by(ScanJob.id)
            ).scalars().first()
            if job is None:
                return
            if job.not_before is not None and _as_utc(job.not_before) > now:
                return  # 야간 창 대기 / waiting for the night window
            job.status = "running"
            job.started_at = now
            db.commit()
            job_id = job.id
        try:
            _execute_scan(job_id, session_factory, validator, settings)
        except Exception as e:  # 백그라운드 격리 — 잡에 기록하고 계속 / isolate, record, continue
            logger.exception("scan job %s failed", job_id)
            with session_factory() as db:
                job = db.get(ScanJob, job_id)
                job.status = "failed"
                job.error = str(e)[:400]
                job.finished_at = datetime.now(UTC)
                db.commit()


def _as_utc(value: datetime) -> datetime:
    # SQLite는 tz 정보를 버린다 / SQLite drops tzinfo on storage
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _execute_scan(
    job_id: int, session_factory: sessionmaker,
    validator: JoinValidator, settings: Settings,
) -> None:
    blacklist = {name.upper() for name in settings.low_cardinality_blacklist}

    with session_factory() as db:
        job = db.get(ScanJob, job_id)
        src_ref = _to_ref(job.src_object, job.src_column)
        # 관계 탐색은 "FK가 13개뿐인 레거시 MSSQL" 전용 기계다(스펙 비목표) — 스냅샷 id는
        # 전 소스 공통 시퀀스라 소스를 안 걸면 나중에 수집된 PG/SQLite 스냅샷이 "최신"이
        # 되어, 잡의 src_object가 그 스냅샷에 없다는 이유로 기능이 통째로 죽는다.
        # 여기를 다른 소스로 일반화하지 말 것 — 검증기 자체가 n8n/MSSQL 전용이다.
        # / relation scanning is MSSQL-only by design; snapshot ids are one global
        #   sequence, so without this filter a newer non-MSSQL snapshot wins and the
        #   feature dies with "source column ... not in latest snapshot"
        snapshot = db.execute(
            select(Snapshot).where(Snapshot.status == "ready",
                                   Snapshot.data_source_id == MANAGED_MSSQL_SOURCE_ID)
            .order_by(Snapshot.id.desc()).limit(1)
        ).scalar_one_or_none()
        if snapshot is None:
            raise RuntimeError("no ready snapshot to scan against")
        columns = load_scoring_columns(db, snapshot.id)
        src = next(
            (c for c in columns.values()
             if c.object_qname == job.src_object and c.name == job.src_column),
            None,
        )
        if src is None:
            raise RuntimeError(f"source column {src_ref} not in latest snapshot")

        # 타입·제외 필터로 후보 축소 (계획 §4) / shrink the candidate universe
        candidates = [
            c for c in columns.values()
            if c.object_qname != src.object_qname
            and scoring.check_exclusion(
                c, settings.low_cardinality_min_distinct, blacklist
            ) is None
            and scoring.is_type_compatible(src, c)
        ]
        job.progress_total = len(candidates) + settings.scan_full_recheck_top
        db.commit()

    # 1차 리콜 — live에선 TABLESAMPLE 단계 / coarse recall pass
    coarse: list[tuple[scoring.ScoringColumn, float]] = []
    done = 0
    for candidate in candidates:
        try:
            result = validator.containment(src_ref, _to_ref(candidate.object_qname, candidate.name))
            coarse.append((candidate, result.containment))
        except ValidationDataMissing:
            pass  # 값 데이터 없는 컬럼은 건너뜀 / no data, skip
        done += 1
        if done % _PROGRESS_COMMIT_EVERY == 0:
            with session_factory() as db:
                db.get(ScanJob, job_id).progress_done = done
                db.commit()

    coarse.sort(key=lambda pair: (-pair[1], pair[0].object_qname, pair[0].name))
    top = coarse[: settings.scan_full_recheck_top]

    # 상위 후보만 풀 재검증 + 영구 기록 / full recheck and persist the top hits
    now = datetime.now(UTC)
    with session_factory() as db:
        job = db.get(ScanJob, job_id)
        for rank, (candidate, sample_containment) in enumerate(top, start=1):
            tgt_ref = _to_ref(candidate.object_qname, candidate.name)
            result = validator.containment(src_ref, tgt_ref)
            db.add(ScanResult(
                job_id=job_id, tgt_object=candidate.object_qname, tgt_column=candidate.name,
                containment_sample=sample_containment, containment_full=result.containment,
                cardinality=result.cardinality, rank=rank,
            ))
            if result.containment >= settings.scan_min_containment:
                record_observation(db, src_ref, tgt_ref, result, f"scan:{job_id}", now)
            done += 1
        job.progress_done = job.progress_total
        job.status = "done"
        job.finished_at = datetime.now(UTC)
        db.commit()
