"""Object search and anchor-based graph expansion. / 객체 검색 + 앵커 N-hop 그래프 조회."""

from collections import deque
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session, aliased

from app.adapters.table_preview import FakeTablePreview
from app.auth import get_current_user
from app.config import get_settings
from app.db import get_db
from app.models import (
    AiSummary,
    AuditLog,
    CatalogColumn,
    CatalogConstraint,
    CatalogObject,
    FkColumn,
    Relation,
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
    limit: int = Query(50, ge=1, le=1000),
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


@router.get("/{object_id}/detail")
def get_object_detail(object_id: int, db: Session = Depends(get_db)) -> dict:
    """테이블 브라우저 우측 패널 데이터 — 사용 뷰·유사 테이블·관계 요약 / detail panel payload."""
    obj = db.get(CatalogObject, object_id)
    if obj is None:
        raise HTTPException(404, {"message": "object not found", "context": {"object_id": object_id}})
    qname = f"{obj.schema}.{obj.name}"

    columns = db.execute(
        select(CatalogColumn).where(CatalogColumn.object_id == obj.id)
        .order_by(CatalogColumn.ordinal)
    ).scalars().all()

    # 이 테이블을 사용하는 뷰 / views whose lineage lands on this table
    base_view = aliased(CatalogObject)
    using_views = [
        {"id": vid, "name": f"{schema}.{name}", "min_depth": depth}
        for vid, schema, name, depth in db.execute(
            select(base_view.id, base_view.schema, base_view.name,
                   func.min(ViewLineageFlat.depth))
            .join(ViewLineageFlat, ViewLineageFlat.view_object_id == base_view.id)
            .where(ViewLineageFlat.base_object_id == obj.id)
            .group_by(base_view.id, base_view.schema, base_view.name)
            .order_by(func.min(ViewLineageFlat.depth), base_view.name)
        )
    ]

    # 유사 테이블 — 컬럼명 일치율 |공통|/|내 컬럼| / column-name match rate
    own_columns = {c.name for c in columns}
    similar = []
    if own_columns and obj.type == "table":
        peer_columns: dict[int, set[str]] = {}
        peer_names: dict[int, str] = {}
        for peer_id, schema, name, column_name in db.execute(
            select(CatalogObject.id, CatalogObject.schema, CatalogObject.name,
                   CatalogColumn.name)
            .join(CatalogColumn, CatalogColumn.object_id == CatalogObject.id)
            .where(CatalogObject.snapshot_id == obj.snapshot_id,
                   CatalogObject.type == "table", CatalogObject.id != obj.id)
        ):
            peer_columns.setdefault(peer_id, set()).add(column_name)
            peer_names[peer_id] = f"{schema}.{name}"
        for peer_id, cols in peer_columns.items():
            common = own_columns & cols
            rate = len(common) / len(own_columns)
            if rate >= 0.3:
                similar.append({
                    "id": peer_id, "name": peer_names[peer_id],
                    "match_rate": round(rate, 3), "common_columns": len(common),
                })
        similar.sort(key=lambda s: (-s["match_rate"], s["name"]))
        similar = similar[:8]

    # FK 요약 / FK in-out summary
    src_col, tgt_col = aliased(CatalogColumn), aliased(CatalogColumn)
    fk_out = [
        f"{schema}.{name}"
        for schema, name in db.execute(
            select(CatalogObject.schema, CatalogObject.name).distinct()
            .join(tgt_col, tgt_col.object_id == CatalogObject.id)
            .join(FkColumn, FkColumn.tgt_column_id == tgt_col.id)
            .join(src_col, FkColumn.src_column_id == src_col.id)
            .where(src_col.object_id == obj.id)
        )
    ]
    fk_in = [
        f"{schema}.{name}"
        for schema, name in db.execute(
            select(CatalogObject.schema, CatalogObject.name).distinct()
            .join(src_col, src_col.object_id == CatalogObject.id)
            .join(FkColumn, FkColumn.src_column_id == src_col.id)
            .join(tgt_col, FkColumn.tgt_column_id == tgt_col.id)
            .where(tgt_col.object_id == obj.id)
        )
    ]

    # 추론·확정 관계 (텍스트 식별자 매칭) / inferred and confirmed relations
    relations = [
        {
            "other": rel.tgt_object if rel.src_object == qname else rel.src_object,
            "src_column": rel.src_column, "tgt_column": rel.tgt_column,
            "status": rel.status, "confidence": rel.confidence,
            "cardinality": rel.cardinality,
        }
        for rel in db.execute(
            select(Relation).where(
                Relation.status.in_(["validated", "confirmed"]),
                (Relation.src_object == qname) | (Relation.tgt_object == qname),
            )
        ).scalars()
    ]

    summary = db.execute(
        select(AiSummary.summary).where(AiSummary.object_qname == qname)
    ).scalar_one_or_none()

    fk_column_ids = {
        cid for (cid,) in db.execute(
            select(FkColumn.src_column_id).join(src_col, FkColumn.src_column_id == src_col.id)
            .where(src_col.object_id == obj.id)
        )
    } | {
        cid for (cid,) in db.execute(
            select(FkColumn.tgt_column_id).join(tgt_col, FkColumn.tgt_column_id == tgt_col.id)
            .where(tgt_col.object_id == obj.id)
        )
    }

    # 뷰의 구성 테이블 — lineage flat 역방향 / base tables a view resolves to
    base_tables = []
    if obj.type == "view":
        base_obj = aliased(CatalogObject)
        base_tables = [
            {"id": bid, "name": f"{schema}.{name}", "min_depth": depth}
            for bid, schema, name, depth in db.execute(
                select(base_obj.id, base_obj.schema, base_obj.name,
                       func.min(ViewLineageFlat.depth))
                .join(ViewLineageFlat, ViewLineageFlat.base_object_id == base_obj.id)
                .where(ViewLineageFlat.view_object_id == obj.id)
                .group_by(base_obj.id, base_obj.schema, base_obj.name)
                .order_by(func.min(ViewLineageFlat.depth), base_obj.name)
            )
        ]

    return {
        "id": obj.id, "name": qname, "type": obj.type, "row_count": obj.row_count,
        "column_count": len(columns),
        "ai_summary": summary,
        "columns": [
            {"id": c.id, "name": c.name, "data_type": c.data_type, "is_pk": c.is_pk,
             "is_join_key": c.is_pk or c.id in fk_column_ids}
            for c in columns
        ],
        "using_views": using_views,
        "base_tables": base_tables,
        "similar_tables": similar,
        "fk_out": sorted(fk_out), "fk_in": sorted(fk_in),
        "relations": relations,
    }


# 미리보기 기본·상한 — 기본 20, 요청으로 늘리되 서버 상한은 유지 (계획 §3.5 원칙 보존)
# default 20; client may raise it, but the hard server cap stays
TABLE_PREVIEW_LIMIT = 20
TABLE_PREVIEW_MAX = 500


@router.get("/{object_id}/preview")
def get_object_preview(
    object_id: int,
    filter_column: str | None = None,
    filter_value: str | None = Query(None, max_length=100),
    limit: int = Query(TABLE_PREVIEW_LIMIT, ge=1, le=TABLE_PREVIEW_MAX),
    db: Session = Depends(get_db),
    login_id: str = Depends(get_current_user),
) -> dict:
    """TOP 20 미리보기 — 무캐시·마스킹·감사 + 컬럼·값 재검색 (계획 §3.5 원칙 준용)."""
    obj = db.get(CatalogObject, object_id)
    if obj is None:
        raise HTTPException(404, {"message": "object not found", "context": {"object_id": object_id}})
    settings = get_settings()
    if settings.source_mode == "live":
        # 연결 단계(정지점 18)에서 pyodbc SELECT TOP 20 (+ WHERE)으로 교체 / swapped at step 18
        raise HTTPException(501, {"message": "live table preview lands at connection step 18"})

    qname = f"{obj.schema}.{obj.name}"
    columns = db.execute(
        select(CatalogColumn).where(CatalogColumn.object_id == obj.id)
        .order_by(CatalogColumn.ordinal)
    ).scalars().all()
    column_names = {c.name for c in columns}
    if filter_column is not None and filter_column not in column_names:
        raise HTTPException(400, {"message": "unknown filter column",
                                  "context": {"filter_column": filter_column}})
    column_specs = [{"name": c.name, "data_type": c.data_type} for c in columns]

    preview = FakeTablePreview(Path(settings.fixture_dir) / "value_sets.json")
    rows = preview.rows(
        qname, column_specs, limit,
        filter_column=filter_column, filter_value=filter_value,
    )

    masked = [c.name for c in columns if c.masking_policy]
    if masked:
        masked_set = set(masked)
        rows = [
            {k: ("●●●" if k in masked_set else v) for k, v in row.items()}
            for row in rows
        ]

    now = datetime.now(UTC)
    filter_note = f" filter {filter_column}~'{filter_value}'" if filter_column else ""
    db.add(AuditLog(action="table_preview",
                    detail=f"{qname} ({len(rows)} rows){filter_note}",
                    requested_by=login_id, requested_at=now))
    return {
        "object": qname,
        "columns": [c.name for c in columns],
        "rows": rows,
        "masked_columns": masked,
        "limit": limit,
        "filter": (
            {"column": filter_column, "value": filter_value} if filter_column else None
        ),
        "observed_at": now.isoformat(),
    }


@router.get("/columns-index")
def get_columns_index(
    snapshot_id: int | None = None, db: Session = Depends(get_db)
) -> dict:
    """테이블별 컬럼명 인덱스 — 브라우저 컬럼 검색용 / column-name index for client search."""
    snapshot = resolve_snapshot(db, snapshot_id)
    index: dict[int, list[str]] = {}
    for object_id, name in db.execute(
        select(CatalogColumn.object_id, CatalogColumn.name)
        .join(CatalogObject, CatalogColumn.object_id == CatalogObject.id)
        .where(CatalogObject.snapshot_id == snapshot.id, CatalogObject.type == "table")
        .order_by(CatalogColumn.object_id, CatalogColumn.ordinal)
    ):
        index.setdefault(object_id, []).append(name)
    return {
        "snapshot_id": snapshot.id,
        "items": [{"object_id": oid, "columns": cols} for oid, cols in index.items()],
    }


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


def _load_relation_edges(db: Session, qname_to_id: dict[str, int]) -> list[dict]:
    """검증·확정·AI 제안 관계를 현재 스냅샷에 매핑 / relations mapped onto this snapshot."""
    edges = []
    for rel in db.execute(
        select(Relation).where(
            Relation.status.in_(["validated", "confirmed"])
            # AI 제안은 검증 전에도 노출하되 ai_suggested로 명확히 구분 (계획 §5.3)
            | ((Relation.status == "candidate") & (Relation.origin == "ai"))
        )
    ).scalars():
        src, tgt = qname_to_id.get(rel.src_object), qname_to_id.get(rel.tgt_object)
        if src is None or tgt is None:
            continue  # 이번 스냅샷에 없는 객체 / object absent from this snapshot
        if rel.status == "candidate":
            kind = "ai_suggested"
        elif rel.status == "confirmed":
            kind = "confirmed"
        else:
            kind = "inferred"
        edges.append({
            "id": f"rel-{rel.id}",
            "kind": kind,
            "src_object_id": src, "tgt_object_id": tgt,
            "columns": [{"src_column": rel.src_column, "tgt_column": rel.tgt_column}],
            "confidence": rel.confidence, "cardinality": rel.cardinality,
            "last_verified_at": (
                rel.last_verified_at.isoformat() if rel.last_verified_at else None
            ),
        })
    return edges


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

    qname_to_id = {
        f"{schema}.{name}": oid
        for oid, schema, name in db.execute(
            select(CatalogObject.id, CatalogObject.schema, CatalogObject.name)
            .where(CatalogObject.snapshot_id == sid)
        )
    }
    fk_edges = _load_fk_edges(db, sid)
    lineage_edges, lineage_flags = _load_lineage_edges(db, sid)
    relation_edges = _load_relation_edges(db, qname_to_id)

    adjacency: dict[int, set[int]] = {}
    for e in fk_edges + lineage_edges + relation_edges:
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
        e for e in fk_edges + lineage_edges + relation_edges
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

    id_to_qname = {oid: q for q, oid in qname_to_id.items()}
    summaries = {
        s.object_qname: s.summary
        for s in db.execute(
            select(AiSummary).where(
                AiSummary.object_qname.in_([id_to_qname[i] for i in included])
            )
        ).scalars()
    }
    nodes = [
        {
            "id": obj.id, "schema": obj.schema, "name": obj.name, "type": obj.type,
            "row_count": obj.row_count, "dmv_unresolved": obj.dmv_unresolved,
            "lineage_flag": lineage_flags.get(obj.id),
            "unresolved_dep_count": unresolved_counts.get(obj.id, 0),
            "ai_summary": summaries.get(f"{obj.schema}.{obj.name}"),
            "columns": columns_by_object.get(obj.id, []),
        }
        for obj in db.execute(
            select(CatalogObject).where(CatalogObject.id.in_(included))
            .order_by(CatalogObject.schema, CatalogObject.name)
        ).scalars()
    ]
    return {"snapshot_id": sid, "anchor_id": anchor.id, "depth": depth,
            "nodes": nodes, "edges": edges}
