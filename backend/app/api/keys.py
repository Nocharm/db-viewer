"""Join-key aggregation for the table browser. / 조인키 집계 (메인 화면 필터 바)."""

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session, aliased

from app.api.objects import resolve_snapshot
from app.db import get_db
from app.models import (
    CatalogColumn,
    CatalogConstraint,
    CatalogObject,
    FkColumn,
    Relation,
    ViewJoin,
)

router = APIRouter(tags=["keys"])


@router.get("/api/join-keys")
def list_join_keys(
    snapshot_id: int | None = None, source_id: int | None = None,
    db: Session = Depends(get_db),
) -> dict:
    """FK·뷰 JOIN·검증 관계에 등장한 키 컬럼 집계 / keys seen in FKs, view joins, relations."""
    snapshot = resolve_snapshot(db, snapshot_id, source_id)

    # key name → 사용 테이블 id 집합 + 근거별 등장 횟수 / tables and per-source usage
    tables_by_key: dict[str, set[int]] = {}
    usage_by_key: dict[str, int] = {}

    def record(key: str, object_id: int) -> None:
        tables_by_key.setdefault(key, set()).add(object_id)
        usage_by_key[key] = usage_by_key.get(key, 0) + 1

    col = aliased(CatalogColumn)
    for constraint_type, column_id_attr in (
        ("fk", FkColumn.src_column_id), ("fk", FkColumn.tgt_column_id),
    ):
        for name, object_id in db.execute(
            select(col.name, col.object_id)
            .join(FkColumn, column_id_attr == col.id)
            .join(CatalogConstraint, FkColumn.constraint_id == CatalogConstraint.id)
            .where(CatalogConstraint.snapshot_id == snapshot.id,
                   CatalogConstraint.type == constraint_type)
        ):
            record(name, object_id)

    for column_id_attr in (ViewJoin.left_column_id, ViewJoin.right_column_id):
        for name, object_id in db.execute(
            select(col.name, col.object_id)
            .join(ViewJoin, column_id_attr == col.id)
            .where(ViewJoin.snapshot_id == snapshot.id)
        ):
            record(name, object_id)

    qname_to_id = {
        f"{schema}.{name}": oid
        for oid, schema, name in db.execute(
            select(CatalogObject.id, CatalogObject.schema, CatalogObject.name)
            .where(CatalogObject.snapshot_id == snapshot.id)
        )
    }
    for rel in db.execute(
        select(Relation).where(Relation.status.in_(["validated", "confirmed"]))
    ).scalars():
        for obj_qname, column in ((rel.src_object, rel.src_column),
                                  (rel.tgt_object, rel.tgt_column)):
            object_id = qname_to_id.get(obj_qname)
            if object_id is not None:
                record(column, object_id)

    items = [
        {
            "key": key,
            "table_count": len(tables_by_key[key]),
            "usage": usage_by_key[key],
            "table_ids": sorted(tables_by_key[key]),
        }
        for key in tables_by_key
    ]
    items.sort(key=lambda i: (-i["table_count"], -i["usage"], i["key"]))
    return {
        "snapshot_id": snapshot.id, "source_id": snapshot.data_source_id,
        "items": items[:40],
    }
