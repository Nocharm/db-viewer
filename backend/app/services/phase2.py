"""Phase 2 orchestration — parse views, persist column lineage and joins. / 파싱→적재 오케스트레이션."""

from sqlalchemy import insert, select, update
from sqlalchemy.orm import Session

from app.config import get_settings
from app.domain import column_lineage, view_parsing
from app.models import CatalogColumn, CatalogObject, ViewJoin, ViewLineageFlat


def run_phase2(db: Session, snapshot_id: int) -> dict:
    """Parse every view definition in the snapshot; augment lineage, extract joins. / 스냅샷 전체 뷰 파싱."""
    objects = db.execute(
        select(CatalogObject).where(CatalogObject.snapshot_id == snapshot_id)
    ).scalars().all()
    qname_of = {o.id: f"{o.schema}.{o.name}" for o in objects}
    ids_by_qname = {q: oid for oid, q in qname_of.items()}
    object_types = {qname_of[o.id]: o.type for o in objects}

    table_columns: dict[str, list[str]] = {}
    column_ids: dict[tuple[str, str], int] = {}
    for col in db.execute(
        select(CatalogColumn)
        .where(CatalogColumn.object_id.in_(qname_of.keys()))
        .order_by(CatalogColumn.object_id, CatalogColumn.ordinal)
    ).scalars():
        q = qname_of[col.object_id]
        table_columns.setdefault(q, []).append(col.name)
        column_ids[(q, col.name)] = col.id

    # 파싱 — 실패는 상태로 격리, 파이프라인은 계속 / failures isolate, pipeline continues
    parsed: dict[str, view_parsing.ParsedView] = {}
    status_updates = []
    for obj in objects:
        if obj.type != "view" or obj.definition is None:
            continue
        result = view_parsing.parse_view(obj.definition)
        parsed[qname_of[obj.id]] = result
        status_updates.append({
            "id": obj.id, "parse_status": result.status, "parse_error": result.error,
        })
    if status_updates:
        # ORM bulk UPDATE by primary key — dict에 PK("id") 포함이 계약
        db.execute(update(CatalogObject), status_updates)

    # 컬럼 정밀 lineage — 카탈로그 set 행을 덮지 않고 보강 (계획 §2.2)
    resolved = column_lineage.build_column_lineage(
        parsed, object_types, table_columns,
        depth_limit=get_settings().lineage_depth_limit,
    )
    lineage_rows = [
        {
            "snapshot_id": snapshot_id,
            "view_object_id": ids_by_qname[r["view"]],
            "view_column": r["view_column"],
            "base_object_id": ids_by_qname[r["base"]],
            "base_column": r["base_column"],
            "depth": r["depth"], "mapping_kind": r["mapping_kind"], "flag": None,
        }
        for r in column_lineage.flatten_rows(resolved)
    ]
    if lineage_rows:
        db.execute(insert(ViewLineageFlat), lineage_rows)

    # JOIN 추출 → view_joins (관계 추론 최상위 신호) / top-weight relation signal
    join_counts: dict[tuple[int, int, int, str], int] = {}
    for view_qname, result in parsed.items():
        if result.status not in ("ok", "partial"):
            continue
        for join in result.joins:
            (l_ref, l_col), (r_ref, r_col) = join.left, join.right
            if l_ref.database or r_ref.database:
                continue  # 크로스 DB 엔드포인트는 카탈로그 밖 / cross-DB endpoints
            left_id = column_ids.get((l_ref.qname, l_col))
            right_id = column_ids.get((r_ref.qname, r_col))
            if left_id is None or right_id is None:
                continue  # 드랍된 테이블 등 카탈로그 밖 참조 / not in catalog
            key = (ids_by_qname[view_qname], left_id, right_id, join.join_type)
            join_counts[key] = join_counts.get(key, 0) + 1
    join_rows = [
        {
            "snapshot_id": snapshot_id, "view_object_id": vid,
            "left_column_id": left, "right_column_id": right,
            "join_type": jt, "occurrence_count": count,
        }
        for (vid, left, right, jt), count in join_counts.items()
    ]
    if join_rows:
        db.execute(insert(ViewJoin), join_rows)

    by_status: dict[str, int] = {}
    for result in parsed.values():
        by_status[result.status] = by_status.get(result.status, 0) + 1
    return {
        "views_parsed": len(parsed),
        **{f"parse_{k}": v for k, v in sorted(by_status.items())},
        "column_lineage_rows": len(lineage_rows),
        "view_joins": len(join_rows),
    }
