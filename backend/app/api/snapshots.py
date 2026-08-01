"""Snapshot listing and schema-drift diff. / 스냅샷 목록·스키마 드리프트 비교."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session, aliased

from app.db import get_db
from app.models import (
    CatalogColumn,
    CatalogConstraint,
    CatalogObject,
    FkColumn,
    Snapshot,
)

router = APIRouter(prefix="/api/snapshots", tags=["snapshots"])

# (schema, name, type) → 스냅샷 간 객체 매칭 키 / cross-snapshot object identity
ObjKey = tuple[str, str, str]


@router.get("")
def list_snapshots(db: Session = Depends(get_db)) -> dict:
    object_count = (
        select(func.count()).where(CatalogObject.snapshot_id == Snapshot.id).scalar_subquery()
    )
    items = [
        {
            "id": snap.id, "collected_at": snap.collected_at.isoformat(),
            "source_db": snap.source_db, "status": snap.status, "object_count": count,
        }
        for snap, count in db.execute(
            select(Snapshot, object_count).order_by(Snapshot.id.desc())
        )
    ]
    return {"items": items}


def _load_objects(db: Session, snapshot_id: int) -> dict[ObjKey, int]:
    return {
        (o.schema, o.name, o.type): o.id
        for o in db.execute(
            select(CatalogObject).where(CatalogObject.snapshot_id == snapshot_id)
        ).scalars()
    }


def _load_columns(db: Session, object_ids: list[int]) -> dict[int, dict[str, tuple]]:
    """object_id → {column_name: (data_type, max_length, is_nullable)}"""
    out: dict[int, dict[str, tuple]] = {}
    for c in db.execute(
        select(CatalogColumn).where(CatalogColumn.object_id.in_(object_ids))
    ).scalars():
        out.setdefault(c.object_id, {})[c.name] = (c.data_type, c.max_length, c.is_nullable)
    return out


def _load_fk_signatures(db: Session, snapshot_id: int) -> dict[tuple, str]:
    """FK 시그니처(이름 아님) 기준 매칭 — 자동 생성 이름 변동에 안전 / name-agnostic FK identity."""
    src_col, tgt_col = aliased(CatalogColumn), aliased(CatalogColumn)
    src_obj, tgt_obj = aliased(CatalogObject), aliased(CatalogObject)
    pairs: dict[int, dict] = {}
    for cid, name, s_schema, s_name, t_schema, t_name, s_col, t_col in db.execute(
        select(
            CatalogConstraint.id, CatalogConstraint.name,
            src_obj.schema, src_obj.name, tgt_obj.schema, tgt_obj.name,
            src_col.name, tgt_col.name,
        )
        .join(FkColumn, FkColumn.constraint_id == CatalogConstraint.id)
        .join(src_col, FkColumn.src_column_id == src_col.id)
        .join(tgt_col, FkColumn.tgt_column_id == tgt_col.id)
        .join(src_obj, src_col.object_id == src_obj.id)
        .join(tgt_obj, tgt_col.object_id == tgt_obj.id)
        .where(CatalogConstraint.snapshot_id == snapshot_id)
    ):
        entry = pairs.setdefault(cid, {"name": name, "src": f"{s_schema}.{s_name}",
                                       "tgt": f"{t_schema}.{t_name}", "cols": []})
        entry["cols"].append((s_col, t_col))
    return {
        (e["src"], e["tgt"], tuple(sorted(e["cols"]))): e["name"] for e in pairs.values()
    }


@router.get("/{snapshot_id}/parse-stats")
def get_parse_stats(snapshot_id: int, db: Session = Depends(get_db)) -> dict:
    """파싱 성공률 지표 + 실패 목록 (계획 §2.2 관리 화면용) / parse-rate metric and failure list."""
    if db.get(Snapshot, snapshot_id) is None:
        raise HTTPException(404, {"message": "snapshot not found",
                                  "context": {"snapshot_id": snapshot_id}})
    views = db.execute(
        select(CatalogObject)
        .where(CatalogObject.snapshot_id == snapshot_id, CatalogObject.type == "view")
    ).scalars().all()

    counts = {"ok": 0, "partial": 0, "unsupported": 0, "parse_failed": 0, "no_definition": 0}
    failed = []
    for v in views:
        if v.definition is None:
            counts["no_definition"] += 1
            continue
        counts[v.parse_status] += 1
        if v.parse_status in ("parse_failed", "unsupported"):
            failed.append({
                "id": v.id, "name": f"{v.schema}.{v.name}",
                "status": v.parse_status, "error": v.parse_error,
            })

    with_definition = len(views) - counts["no_definition"]
    return {
        "snapshot_id": snapshot_id,
        "total_views": len(views),
        "counts": counts,
        # 성공률 = ok / definition 보유 뷰 / success rate over views with a definition
        "success_rate": round(counts["ok"] / with_definition, 4) if with_definition else None,
        "failed_views": failed[:100],
    }


@router.get("/{snapshot_a}/diff/{snapshot_b}")
def diff_snapshots(snapshot_a: int, snapshot_b: int, db: Session = Depends(get_db)) -> dict:
    """a → b 스키마 드리프트 / schema drift from snapshot a to b."""
    for sid in (snapshot_a, snapshot_b):
        if db.get(Snapshot, sid) is None:
            raise HTTPException(404, {"message": "snapshot not found", "context": {"snapshot_id": sid}})

    objs_a, objs_b = _load_objects(db, snapshot_a), _load_objects(db, snapshot_b)
    added_keys = sorted(objs_b.keys() - objs_a.keys())
    removed_keys = sorted(objs_a.keys() - objs_b.keys())
    common = sorted(objs_a.keys() & objs_b.keys())

    cols_a = _load_columns(db, [objs_a[k] for k in common])
    cols_b = _load_columns(db, [objs_b[k] for k in common])
    col_added, col_removed, col_changed = [], [], []
    for key in common:
        qname = f"{key[0]}.{key[1]}"
        a_cols = cols_a.get(objs_a[key], {})
        b_cols = cols_b.get(objs_b[key], {})
        col_added += [f"{qname}.{c}" for c in sorted(b_cols.keys() - a_cols.keys())]
        col_removed += [f"{qname}.{c}" for c in sorted(a_cols.keys() - b_cols.keys())]
        for c in sorted(a_cols.keys() & b_cols.keys()):
            if a_cols[c] != b_cols[c]:
                before, after = a_cols[c], b_cols[c]
                col_changed.append({
                    "column": f"{qname}.{c}",
                    "before": {"data_type": before[0], "max_length": before[1], "is_nullable": before[2]},
                    "after": {"data_type": after[0], "max_length": after[1], "is_nullable": after[2]},
                })

    fks_a, fks_b = _load_fk_signatures(db, snapshot_a), _load_fk_signatures(db, snapshot_b)

    return {
        "snapshot_a": snapshot_a, "snapshot_b": snapshot_b,
        "objects": {
            "added": [f"{k[0]}.{k[1]}" for k in added_keys],
            "removed": [f"{k[0]}.{k[1]}" for k in removed_keys],
        },
        "columns": {"added": col_added, "removed": col_removed, "changed": col_changed},
        "foreign_keys": {
            "added": sorted(fks_b[sig] for sig in fks_b.keys() - fks_a.keys()),
            "removed": sorted(fks_a[sig] for sig in fks_a.keys() - fks_b.keys()),
        },
    }
