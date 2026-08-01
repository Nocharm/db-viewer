"""Object search and anchor-based graph expansion. / 객체 검색 + 앵커 N-hop 그래프 조회."""

from collections import deque
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session, aliased

from app.db import get_db
from app.models import (
    CatalogColumn,
    CatalogConstraint,
    CatalogObject,
    FkColumn,
    Snapshot,
    ViewDep,
    ViewLineageFlat,
)

router = APIRouter(prefix="/api/objects", tags=["objects"])


def resolve_snapshot(db: Session, snapshot_id: int | None) -> Snapshot:
    """지정 스냅샷 또는 최신 ready 스냅샷 / requested snapshot or the latest ready one."""
    if snapshot_id is not None:
        snapshot = db.get(Snapshot, snapshot_id)
        if snapshot is None:
            raise HTTPException(404, {"message": "snapshot not found",
                                      "context": {"snapshot_id": snapshot_id}})
        return snapshot
    snapshot = db.execute(
        select(Snapshot).where(Snapshot.status == "ready").order_by(Snapshot.id.desc()).limit(1)
    ).scalar_one_or_none()
    if snapshot is None:
        raise HTTPException(404, {"message": "no ready snapshot", "context": {}})
    return snapshot


@router.get("")
def search_objects(
    q: str = "",
    type_filter: Literal["table", "view"] | None = Query(None, alias="type"),
    snapshot_id: int | None = None,
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
) -> dict:
    snapshot = resolve_snapshot(db, snapshot_id)
    column_count = (
        select(func.count())
        .where(CatalogColumn.object_id == CatalogObject.id)
        .scalar_subquery()
    )
    stmt = (
        select(CatalogObject, column_count)
        .where(CatalogObject.snapshot_id == snapshot.id)
        .order_by(CatalogObject.schema, CatalogObject.name)
        .limit(limit)
    )
    if q:
        stmt = stmt.where(CatalogObject.name.ilike(f"%{q}%"))
    if type_filter:
        stmt = stmt.where(CatalogObject.type == type_filter)

    items = [
        {
            "id": obj.id, "schema": obj.schema, "name": obj.name, "type": obj.type,
            "row_count": obj.row_count, "column_count": col_count,
            "dmv_unresolved": obj.dmv_unresolved,
        }
        for obj, col_count in db.execute(stmt)
    ]
    return {"snapshot_id": snapshot.id, "items": items}


def _load_fk_edges(db: Session, snapshot_id: int) -> list[dict]:
    src_col, tgt_col = aliased(CatalogColumn), aliased(CatalogColumn)
    rows = db.execute(
        select(
            CatalogConstraint.id, CatalogConstraint.name,
            src_col.object_id, tgt_col.object_id, src_col.name, tgt_col.name,
        )
        .join(FkColumn, FkColumn.constraint_id == CatalogConstraint.id)
        .join(src_col, FkColumn.src_column_id == src_col.id)
        .join(tgt_col, FkColumn.tgt_column_id == tgt_col.id)
        .where(CatalogConstraint.snapshot_id == snapshot_id)
    )
    edges: dict[int, dict] = {}
    for cid, name, src_obj, tgt_obj, src_name, tgt_name in rows:
        edge = edges.setdefault(cid, {
            "id": f"fk-{cid}", "kind": "fk", "name": name,
            "src_object_id": src_obj, "tgt_object_id": tgt_obj, "columns": [],
        })
        edge["columns"].append({"src_column": src_name, "tgt_column": tgt_name})
    return list(edges.values())


def _load_lineage_edges(db: Session, snapshot_id: int) -> tuple[list[dict], dict[int, str]]:
    """(뷰→베이스 엣지, 뷰별 플래그) / (view→base edges, per-view flags)."""
    edges: dict[tuple[int, int], dict] = {}
    flags: dict[int, str] = {}
    for row in db.execute(
        select(ViewLineageFlat).where(ViewLineageFlat.snapshot_id == snapshot_id)
    ).scalars():
        if row.flag:
            flags[row.view_object_id] = row.flag
            continue
        key = (row.view_object_id, row.base_object_id)
        edge = edges.setdefault(key, {
            "id": f"vl-{key[0]}-{key[1]}", "kind": "view_lineage",
            "src_object_id": row.view_object_id, "tgt_object_id": row.base_object_id,
            "columns": [], "min_depth": row.depth,
        })
        if row.base_column and row.base_column not in edge["columns"]:
            edge["columns"].append(row.base_column)
        edge["min_depth"] = min(edge["min_depth"], row.depth)
    return list(edges.values()), flags


@router.get("/{object_id}/graph")
def get_object_graph(
    object_id: int,
    depth: int = Query(1, ge=1, le=3),
    db: Session = Depends(get_db),
) -> dict:
    """앵커에서 N-hop 확장 — 전체 그래프 반환 없음 / anchor-based expansion, never the full graph."""
    anchor = db.get(CatalogObject, object_id)
    if anchor is None:
        raise HTTPException(404, {"message": "object not found", "context": {"object_id": object_id}})
    sid = anchor.snapshot_id

    fk_edges = _load_fk_edges(db, sid)
    lineage_edges, lineage_flags = _load_lineage_edges(db, sid)

    adjacency: dict[int, set[int]] = {}
    for e in fk_edges + lineage_edges:
        adjacency.setdefault(e["src_object_id"], set()).add(e["tgt_object_id"])
        adjacency.setdefault(e["tgt_object_id"], set()).add(e["src_object_id"])

    included = {anchor.id}
    frontier = deque([(anchor.id, 0)])
    while frontier:
        node, dist = frontier.popleft()
        if dist == depth:
            continue
        for neighbor in sorted(adjacency.get(node, ())):
            if neighbor not in included:
                included.add(neighbor)
                frontier.append((neighbor, dist + 1))

    edges = [
        e for e in fk_edges + lineage_edges
        if e["src_object_id"] in included and e["tgt_object_id"] in included
    ]

    unresolved_counts = dict(db.execute(
        select(ViewDep.view_object_id, func.count())
        .where(ViewDep.snapshot_id == sid, ViewDep.is_resolved.is_(False),
               ViewDep.view_object_id.in_(included))
        .group_by(ViewDep.view_object_id)
    ).all())

    columns_by_object: dict[int, list[dict]] = {}
    for col in db.execute(
        select(CatalogColumn)
        .where(CatalogColumn.object_id.in_(included))
        .order_by(CatalogColumn.object_id, CatalogColumn.ordinal)
    ).scalars():
        columns_by_object.setdefault(col.object_id, []).append({
            "id": col.id, "name": col.name, "data_type": col.data_type,
            "is_pk": col.is_pk, "is_nullable": col.is_nullable, "is_computed": col.is_computed,
        })

    nodes = [
        {
            "id": obj.id, "schema": obj.schema, "name": obj.name, "type": obj.type,
            "row_count": obj.row_count, "dmv_unresolved": obj.dmv_unresolved,
            "lineage_flag": lineage_flags.get(obj.id),
            "unresolved_dep_count": unresolved_counts.get(obj.id, 0),
            "columns": columns_by_object.get(obj.id, []),
        }
        for obj in db.execute(
            select(CatalogObject).where(CatalogObject.id.in_(included))
            .order_by(CatalogObject.schema, CatalogObject.name)
        ).scalars()
    ]
    return {"snapshot_id": sid, "anchor_id": anchor.id, "depth": depth,
            "nodes": nodes, "edges": edges}
