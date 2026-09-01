"""Read-only ERD graph — confirmed relations and real FKs only. / 읽기 전용 ERD 그래프.

앵커·depth가 없다: 검증된 관계만 그리므로 그래프가 작고(FK 13 + 확정 관계),
전체를 한 번에 내려 클라이언트가 연결요소별로 배치한다 (스펙 §ERD).
"""

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.objects import _load_fk_edges
from app.db import get_db
from app.models import AiSummary, CatalogColumn, CatalogObject, Relation, Snapshot
from app.models.sources import MANAGED_MSSQL_SOURCE_ID
from app.services.schema_visibility import get_hidden_schemas

router = APIRouter(prefix="/api/erd", tags=["erd"])


@router.get("")
def get_erd_graph(source_id: int | None = None, db: Session = Depends(get_db)) -> dict:
    """읽기 전용 ERD 그래프 — source_id 생략 시 기본 소스(소스 개념이 없던 기존 화면 호환)."""
    target = source_id if source_id is not None else MANAGED_MSSQL_SOURCE_ID
    sid = db.execute(
        select(func.max(CatalogObject.snapshot_id))
        .join(Snapshot, Snapshot.id == CatalogObject.snapshot_id)
        .where(Snapshot.data_source_id == target)
    ).scalar_one_or_none()
    if sid is None:
        return {"snapshot_id": None, "source_id": target, "nodes": [], "edges": []}

    hidden = get_hidden_schemas()
    qname_to_id = {
        f"{schema}.{name}": oid
        for oid, schema, name in db.execute(
            select(CatalogObject.id, CatalogObject.schema, CatalogObject.name)
            # 뷰 완전 제외 방어선 — API로 뷰 컬럼 관계를 confirm해도 뷰 노드가 그려지지 않도록
            .where(CatalogObject.snapshot_id == sid, CatalogObject.type == "table")
        )
        if schema.lower() not in hidden
    }
    visible_ids = set(qname_to_id.values())

    edges = [e for e in _load_fk_edges(db, sid)
             if e["src_object_id"] in visible_ids and e["tgt_object_id"] in visible_ids]
    for rel in db.execute(
        select(Relation).where(Relation.status == "confirmed")
    ).scalars():
        src = qname_to_id.get(rel.src_object)
        tgt = qname_to_id.get(rel.tgt_object)
        if src is None or tgt is None:
            continue  # 현 스냅샷에 없는 객체 / object absent from this snapshot
        edges.append({
            "id": f"rel-{rel.id}", "kind": "confirmed",
            "src_object_id": src, "tgt_object_id": tgt,
            "columns": [{"src_column": rel.src_column, "tgt_column": rel.tgt_column}],
            "confidence": rel.confidence, "cardinality": rel.cardinality,
            "last_verified_at": (
                rel.last_verified_at.isoformat() if rel.last_verified_at else None
            ),
        })

    included = {e["src_object_id"] for e in edges} | {e["tgt_object_id"] for e in edges}
    columns_by_object: dict[int, list[dict]] = {}
    for col in db.execute(
        select(CatalogColumn)
        .where(CatalogColumn.object_id.in_(included))
        .order_by(CatalogColumn.object_id, CatalogColumn.ordinal)
    ).scalars():
        columns_by_object.setdefault(col.object_id, []).append({
            "id": col.id, "name": col.name, "data_type": col.data_type,
            "is_pk": col.is_pk, "is_nullable": col.is_nullable,
            "is_computed": col.is_computed,
        })

    id_to_qname = {oid: q for q, oid in qname_to_id.items()}
    summaries = {
        s.object_qname: s.summary
        for s in db.execute(
            select(AiSummary).where(
                AiSummary.object_qname.in_([id_to_qname[i] for i in included])
            )
        ).scalars()
    } if included else {}

    nodes = [
        {
            "id": obj.id, "schema": obj.schema, "name": obj.name, "type": obj.type,
            "row_count": obj.row_count, "dmv_unresolved": obj.dmv_unresolved,
            # 읽기 전용 ERD는 뷰가 없어 lineage 개념이 없다 — 노드 형태만 기존과 맞춘다
            "lineage_flag": None, "unresolved_dep_count": 0,
            "ai_summary": summaries.get(f"{obj.schema}.{obj.name}"),
            "columns": columns_by_object.get(obj.id, []),
        }
        for obj in db.execute(
            select(CatalogObject).where(CatalogObject.id.in_(included))
            .order_by(CatalogObject.schema, CatalogObject.name)
        ).scalars()
    ]
    return {"snapshot_id": sid, "source_id": target, "nodes": nodes, "edges": edges}
