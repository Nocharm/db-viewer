"""Ingest endpoints — the mock boundary where n8n (or fixtures) POST raw JSON. / n8n·픽스처가 raw JSON을 밀어넣는 mock 경계."""

import json
import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, insert, select, update
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.domain import ingest_mapping, lineage
from app.models import (
    CatalogColumn,
    CatalogConstraint,
    CatalogObject,
    CollectJob,
    FkColumn,
    Snapshot,
    ViewDep,
    ViewLineageFlat,
)
from app.schemas.ingest import CatalogPayload, ViewDepsPayload
from app.services.phase2 import run_phase2

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ingest", tags=["ingest"])


def _bad_request(message: str, context: dict) -> HTTPException:
    return HTTPException(status_code=400, detail={"message": message, "context": context})


def update_collect_job(
    db: Session, job_id: int | None, stage: str,
    snapshot_id: int | None = None, counts: dict | None = None,
) -> None:
    """수집 잡 단계 갱신 — n8n·픽스처 러너 공통 콜백 지점 / stage callback for collect jobs."""
    if job_id is None:
        return
    job = db.get(CollectJob, job_id)
    if job is None:
        return  # 알 수 없는 잡 id는 무시 — ingest 자체를 막지 않는다 / never block ingest
    job.stage = stage
    if snapshot_id is not None:
        job.snapshot_id = snapshot_id
    if counts is not None:
        merged = json.loads(job.counts) if job.counts else {}
        merged.update(counts)
        job.counts = json.dumps(merged)
    job.updated_at = datetime.now(UTC)


def _resolve_chunk_snapshot(db: Session, payload: CatalogPayload) -> Snapshot:
    """청크 2+는 잡에 기록된 스냅샷에 이어붙인다 / later chunks append to the job's snapshot."""
    if payload.collect_job_id is None:
        raise _bad_request("chunked catalog requires collect_job_id",
                           {"chunk_index": payload.chunk_index})
    job = db.get(CollectJob, payload.collect_job_id)
    if job is None or job.snapshot_id is None:
        raise _bad_request("chunk continuation without an open snapshot",
                           {"collect_job_id": payload.collect_job_id,
                            "chunk_index": payload.chunk_index})
    snapshot = db.get(Snapshot, job.snapshot_id)
    if snapshot is None or snapshot.status != "collecting":
        raise _bad_request("snapshot is not accepting chunks",
                           {"snapshot_id": job.snapshot_id})
    return snapshot


@router.post("/catalog")
def ingest_catalog(payload: CatalogPayload, db: Session = Depends(get_db)) -> dict:
    """Create a new snapshot from a raw catalog dump. / 원본 카탈로그 덤프로 새 스냅샷 생성.

    분할 전송(chunk_total>1) 지원 — 객체 슬라이스 단위 청크를 이어붙이고,
    마지막 청크에서만 catalog_done으로 전환한다. 1/1은 기존 단일 계약 그대로.
    """
    if payload.chunk_index > payload.chunk_total:
        raise _bad_request("chunk_index exceeds chunk_total",
                           {"chunk_index": payload.chunk_index,
                            "chunk_total": payload.chunk_total})
    if payload.chunk_index == 1:
        snapshot = Snapshot(
            collected_at=payload.collected_at, source_db=payload.source_db,
            status="collecting",
        )
        db.add(snapshot)
        db.flush()
    else:
        snapshot = _resolve_chunk_snapshot(db, payload)

    obj_rows = ingest_mapping.build_object_rows(snapshot.id, payload)
    returned = db.execute(
        insert(CatalogObject).returning(CatalogObject.id, CatalogObject.object_id), obj_rows
    ).all()
    oid_map = {raw: svc for svc, raw in returned}

    try:
        col_rows = ingest_mapping.build_column_rows(
            payload.columns, ingest_mapping.build_pk_index(payload.key_constraints), oid_map
        )
    except ingest_mapping.MappingError as e:
        raise _bad_request(str(e), e.context) from e
    db.execute(
        insert(CatalogColumn).returning(
            CatalogColumn.id, CatalogColumn.object_id, CatalogColumn.name
        ),
        col_rows,
    ).all()

    for kc in payload.key_constraints:
        db.add(CatalogConstraint(snapshot_id=snapshot.id, type=kc.type, name=kc.name))
    skipped_fks = 0
    if payload.foreign_keys:
        # FK는 청크 경계를 넘어 참조할 수 있어(마지막 청크에 몰아 전송) DB 기준 전체 맵으로 해석
        # FKs may cross chunk boundaries, so resolve against the snapshot-wide maps
        full_oid_map = {raw: svc for svc, raw in db.execute(
            select(CatalogObject.id, CatalogObject.object_id)
            .where(CatalogObject.snapshot_id == snapshot.id)
        )}
        full_col_map = {(obj_svc, name): col_id for col_id, obj_svc, name in db.execute(
            select(CatalogColumn.id, CatalogColumn.object_id, CatalogColumn.name)
            .join(CatalogObject, CatalogColumn.object_id == CatalogObject.id)
            .where(CatalogObject.snapshot_id == snapshot.id)
        )}
        for fk in payload.foreign_keys:
            resolved = []
            for pair in fk.columns:
                src = full_col_map.get((full_oid_map.get(fk.src_object_id), pair.src_column))
                tgt = full_col_map.get((full_oid_map.get(fk.tgt_object_id), pair.tgt_column))
                if src is None or tgt is None:
                    # 스냅샷에 없는 객체·컬럼을 가리키는 FK는 건너뛴다 — FK는 보조 증거라
                    # 하나 때문에 전체 수집(수천 객체)을 버리지 않는다. 건수는 counts로 드러낸다.
                    # skip rather than abort: FKs are auxiliary; the count surfaces the loss
                    logger.warning("skipping unresolvable foreign key", extra={
                        "fk": fk.name, "src_column": pair.src_column,
                        "tgt_column": pair.tgt_column,
                        "src_object_known": fk.src_object_id in full_oid_map,
                        "tgt_object_known": fk.tgt_object_id in full_oid_map,
                    })
                    resolved = []
                    break
                resolved.append((src, tgt))
            if not resolved:
                skipped_fks += 1
                continue
            constraint = CatalogConstraint(snapshot_id=snapshot.id, type="fk", name=fk.name)
            db.add(constraint)
            db.flush()
            for src, tgt in resolved:
                db.add(FkColumn(constraint_id=constraint.id, src_column_id=src, tgt_column_id=tgt))

    for vd in payload.view_definitions:
        if vd.object_id not in oid_map:
            raise _bad_request("view definition for unknown object", {"object_id": vd.object_id})
        db.execute(
            update(CatalogObject)
            .where(CatalogObject.id == oid_map[vd.object_id])
            .values(definition=vd.definition)
        )

    # 청크 누적치는 DB가 진실 — 요청 단위 길이 합산 대신 스냅샷 기준 재계산
    # the DB is the accumulator: recount per snapshot instead of summing request sizes
    counts = {
        "objects": db.execute(
            select(func.count()).select_from(CatalogObject)
            .where(CatalogObject.snapshot_id == snapshot.id)).scalar_one(),
        "columns": db.execute(
            select(func.count()).select_from(CatalogColumn)
            .join(CatalogObject, CatalogColumn.object_id == CatalogObject.id)
            .where(CatalogObject.snapshot_id == snapshot.id)).scalar_one(),
        "key_constraints": db.execute(
            select(func.count()).select_from(CatalogConstraint)
            .where(CatalogConstraint.snapshot_id == snapshot.id,
                   CatalogConstraint.type != "fk")).scalar_one(),
        "foreign_keys": db.execute(
            select(func.count()).select_from(CatalogConstraint)
            .where(CatalogConstraint.snapshot_id == snapshot.id,
                   CatalogConstraint.type == "fk")).scalar_one(),
    }
    if skipped_fks:
        counts["foreign_keys_skipped"] = skipped_fks
    is_final = payload.chunk_index == payload.chunk_total
    if payload.chunk_total > 1:
        counts["catalog_chunks_done"] = payload.chunk_index
        counts["catalog_chunks_total"] = payload.chunk_total
    update_collect_job(db, payload.collect_job_id,
                       "catalog_done" if is_final else "catalog_running",
                       snapshot_id=snapshot.id, counts=counts)
    return {"snapshot_id": snapshot.id, "counts": counts}


@router.post("/view-deps")
def ingest_view_deps(payload: ViewDepsPayload, db: Session = Depends(get_db)) -> dict:
    """Load view dependencies for a snapshot, then mark it ready. / 뷰 의존성 적재 후 ready 전환.

    분할 수집(chunk_total>1) 지원 — 중간 청크는 적재·진행 갱신만, 마지막 청크가 마무리한다.
    """
    if payload.chunk_index > payload.chunk_total:
        raise _bad_request("chunk_index exceeds chunk_total",
                           {"chunk_index": payload.chunk_index,
                            "chunk_total": payload.chunk_total})
    snapshot = db.get(Snapshot, payload.snapshot_id)
    if snapshot is None:
        raise HTTPException(
            status_code=404,
            detail={"message": "snapshot not found", "context": {"snapshot_id": payload.snapshot_id}},
        )

    oid_map: dict[int, int] = {}
    view_svc_ids: set[int] = set()
    for svc, raw, obj_type in db.execute(
        select(CatalogObject.id, CatalogObject.object_id, CatalogObject.type)
        .where(CatalogObject.snapshot_id == snapshot.id)
    ):
        oid_map[raw] = svc
        if obj_type == "view":
            view_svc_ids.add(svc)

    rows = []
    for dep in payload.deps:
        view_svc = oid_map.get(dep.view_object_id)
        if view_svc is None:
            raise _bad_request("dep references unknown view", {"view_object_id": dep.view_object_id})
        ref_svc = None
        if dep.referenced_object_id is not None:
            ref_svc = oid_map.get(dep.referenced_object_id)
            if ref_svc is None:
                raise _bad_request(
                    "resolved dep references object missing from snapshot",
                    {"referenced_object_id": dep.referenced_object_id},
                )
        rows.append({
            "snapshot_id": snapshot.id, "view_object_id": view_svc,
            "referenced_object_id": ref_svc, "referenced_database": dep.referenced_database,
            "referenced_name": dep.referenced_name, "referenced_column": dep.referenced_column,
            "is_resolved": dep.is_resolved,
        })
    if rows:
        db.execute(insert(ViewDep), rows)

    for unresolved in payload.unresolved_objects:
        svc = oid_map.get(unresolved.object_id)
        if svc is None:
            raise _bad_request("unresolved entry for unknown object", {"object_id": unresolved.object_id})
        db.execute(
            update(CatalogObject).where(CatalogObject.id == svc).values(dmv_unresolved=True)
        )

    total_deps = db.execute(
        select(func.count()).select_from(ViewDep)
        .where(ViewDep.snapshot_id == snapshot.id)).scalar_one()

    # 중간 청크 — 적재만 하고 진행 카운터 갱신, 마무리는 마지막 청크에서
    # intermediate chunk: persist and report progress; finalize on the last chunk
    if payload.chunk_index < payload.chunk_total:
        update_collect_job(db, payload.collect_job_id, "deps_running", counts={
            "deps": total_deps,
            "deps_chunks_done": payload.chunk_index,
            "deps_chunks_total": payload.chunk_total,
        })
        return {"snapshot_id": snapshot.id,
                "chunk_index": payload.chunk_index, "chunk_total": payload.chunk_total}

    # 재귀 해석 → view_lineage_flat 적재 (UI가 읽는 유일한 lineage 테이블)
    # 분할 수집이면 이 청크의 rows가 전부가 아니므로 DB에서 전체 deps를 다시 읽는다
    # resolve from the snapshot-wide deps in the DB (this request may be just the last chunk)
    deps_by_view: dict[int, list[lineage.DepTuple]] = {v: [] for v in view_svc_ids}
    for view_svc, ref_svc, ref_column in db.execute(
        select(ViewDep.view_object_id, ViewDep.referenced_object_id, ViewDep.referenced_column)
        .where(ViewDep.snapshot_id == snapshot.id, ViewDep.is_resolved)
    ):
        deps_by_view[view_svc].append((ref_svc, ref_svc in view_svc_ids, ref_column))
    lineage_rows = lineage.resolve_lineage(
        deps_by_view, depth_limit=get_settings().lineage_depth_limit
    )
    if lineage_rows:
        db.execute(
            insert(ViewLineageFlat),
            [{**r, "snapshot_id": snapshot.id} for r in lineage_rows],
        )

    # Phase 2 — 뷰 DDL 파싱·컬럼 정밀 lineage·JOIN 추출 / parse DDL, augment lineage
    phase2_counts = run_phase2(db, snapshot.id)

    snapshot.status = "ready"
    unresolved_total = db.execute(
        select(func.count()).select_from(CatalogObject)
        .where(CatalogObject.snapshot_id == snapshot.id,
               CatalogObject.dmv_unresolved)).scalar_one()
    counts = {
        "deps": total_deps, "unresolved_objects": unresolved_total,
        "lineage_rows": len(lineage_rows), **phase2_counts,
    }
    if payload.chunk_total > 1:
        counts["deps_chunks_done"] = payload.chunk_total
        counts["deps_chunks_total"] = payload.chunk_total
    update_collect_job(db, payload.collect_job_id, "ready", counts=counts)
    return {"snapshot_id": snapshot.id, "counts": counts}
