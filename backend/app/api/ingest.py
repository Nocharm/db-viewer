"""Ingest endpoints — the mock boundary where n8n (or fixtures) POST raw JSON. / n8n·픽스처가 raw JSON을 밀어넣는 mock 경계."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import insert, select, update
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.domain import ingest_mapping, lineage
from app.models import (
    CatalogColumn,
    CatalogConstraint,
    CatalogObject,
    FkColumn,
    Snapshot,
    ViewDep,
    ViewLineageFlat,
)
from app.schemas.ingest import CatalogPayload, ViewDepsPayload

router = APIRouter(prefix="/api/ingest", tags=["ingest"])


def _bad_request(message: str, context: dict) -> HTTPException:
    return HTTPException(status_code=400, detail={"message": message, "context": context})


@router.post("/catalog")
def ingest_catalog(payload: CatalogPayload, db: Session = Depends(get_db)) -> dict:
    """Create a new snapshot from a raw catalog dump. / 원본 카탈로그 덤프로 새 스냅샷 생성."""
    snapshot = Snapshot(
        collected_at=payload.collected_at, source_db=payload.source_db, status="collecting"
    )
    db.add(snapshot)
    db.flush()

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
    returned_cols = db.execute(
        insert(CatalogColumn).returning(
            CatalogColumn.id, CatalogColumn.object_id, CatalogColumn.name
        ),
        col_rows,
    ).all()
    col_map = {(obj_svc, name): col_id for col_id, obj_svc, name in returned_cols}

    for kc in payload.key_constraints:
        db.add(CatalogConstraint(snapshot_id=snapshot.id, type=kc.type, name=kc.name))
    for fk in payload.foreign_keys:
        constraint = CatalogConstraint(snapshot_id=snapshot.id, type="fk", name=fk.name)
        db.add(constraint)
        db.flush()
        for pair in fk.columns:
            src = col_map.get((oid_map.get(fk.src_object_id), pair.src_column))
            tgt = col_map.get((oid_map.get(fk.tgt_object_id), pair.tgt_column))
            if src is None or tgt is None:
                raise _bad_request(
                    "foreign key references unknown column",
                    {"fk": fk.name, "src": pair.src_column, "tgt": pair.tgt_column},
                )
            db.add(FkColumn(constraint_id=constraint.id, src_column_id=src, tgt_column_id=tgt))

    for vd in payload.view_definitions:
        if vd.object_id not in oid_map:
            raise _bad_request("view definition for unknown object", {"object_id": vd.object_id})
        db.execute(
            update(CatalogObject)
            .where(CatalogObject.id == oid_map[vd.object_id])
            .values(definition=vd.definition)
        )

    return {
        "snapshot_id": snapshot.id,
        "counts": {
            "objects": len(obj_rows), "columns": len(col_rows),
            "key_constraints": len(payload.key_constraints),
            "foreign_keys": len(payload.foreign_keys),
        },
    }


@router.post("/view-deps")
def ingest_view_deps(payload: ViewDepsPayload, db: Session = Depends(get_db)) -> dict:
    """Load view dependencies for a snapshot, then mark it ready. / 뷰 의존성 적재 후 ready 전환."""
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

    # 재귀 해석 → view_lineage_flat 적재 (UI가 읽는 유일한 lineage 테이블)
    # resolve recursively and persist the only lineage table the UI reads
    deps_by_view: dict[int, list[lineage.DepTuple]] = {v: [] for v in view_svc_ids}
    for row in rows:
        if row["is_resolved"]:
            ref = row["referenced_object_id"]
            deps_by_view[row["view_object_id"]].append(
                (ref, ref in view_svc_ids, row["referenced_column"])
            )
    lineage_rows = lineage.resolve_lineage(
        deps_by_view, depth_limit=get_settings().lineage_depth_limit
    )
    if lineage_rows:
        db.execute(
            insert(ViewLineageFlat),
            [{**r, "snapshot_id": snapshot.id} for r in lineage_rows],
        )

    snapshot.status = "ready"
    return {"snapshot_id": snapshot.id, "counts": {
        "deps": len(rows), "unresolved_objects": len(payload.unresolved_objects),
        "lineage_rows": len(lineage_rows),
    }}
