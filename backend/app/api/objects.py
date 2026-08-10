"""Object search, detail, and preview. / 객체 검색 + 상세 + 미리보기."""

from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session, aliased

from app.adapters import SyntheticDataRefused, create_table_preview
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
    ViewLineageFlat,
)
from app.services.preview_policy import is_preview_allowed, list_allowed_schemas
from app.services.schema_visibility import (
    get_hidden_schemas,
    is_schema_hidden,
    should_render_hidden_schemas,
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
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
) -> dict:
    """객체 목록 — limit은 페이지 크기, total은 필터 적용 후 전체 수.

    total 없이 잘린 목록만 주면 화면이 "이게 전부"라고 거짓말한다 (실규모 3,224 객체 >
    페이지 상한 1,000). 클라이언트는 total까지 offset으로 페이징해 전량을 모은다.
    """
    snapshot = resolve_snapshot(db, snapshot_id)
    column_count = (
        select(func.count())
        .where(CatalogColumn.object_id == CatalogObject.id)
        .scalar_subquery()
    )
    filters = [CatalogObject.snapshot_id == snapshot.id]
    if q:
        filters.append(CatalogObject.name.ilike(f"%{q}%"))
    if type_filter:
        filters.append(CatalogObject.type == type_filter)

    total = db.execute(
        select(func.count()).select_from(CatalogObject).where(*filters)
    ).scalar_one()
    stmt = (
        select(CatalogObject, column_count)
        .where(*filters)
        # 페이지 경계에서 중복·누락이 없으려면 정렬이 결정론적이어야 한다 — 동명 대비 id 타이브레이크
        .order_by(CatalogObject.schema, CatalogObject.name, CatalogObject.id)
        .limit(limit)
        .offset(offset)
    )

    items = [
        {
            "id": obj.id, "schema": obj.schema, "name": obj.name, "type": obj.type,
            "row_count": obj.row_count, "column_count": col_count,
            "dmv_unresolved": obj.dmv_unresolved,
        }
        for obj, col_count in db.execute(stmt)
    ]
    return {"snapshot_id": snapshot.id, "total": total, "items": items}


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
            "cardinality": rel.cardinality, "reason": rel.reason,
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

    # 감춘 스키마는 컬럼 배열만 비운다 — 이름·규모·관계는 그대로 둔다(다른 테이블에서
    # 이어지는 관계를 읽으려면 필요하고, 그건 요청상 허용된다). column_count는 목록·검색이
    # 이미 내보내는 값이라 여기서만 감추면 화면끼리 어긋난다.
    # / a hidden schema only loses the column array; name, size and relations stay, since
    # relations from other tables must remain readable. column_count is already in the
    # search payload — withholding it only here would make the two screens disagree.
    hidden = is_schema_hidden(obj.schema)

    return {
        "id": obj.id, "name": qname, "type": obj.type, "row_count": obj.row_count,
        "column_count": len(columns),
        "ai_summary": summary,
        "hidden": hidden,
        "columns": [] if hidden else [
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


@router.get("/preview-allowlist")
def get_preview_allowlist(db: Session = Depends(get_db)) -> dict:
    """미리보기가 허용된 스키마 목록 — 화면이 버튼 활성 여부를 정하는 근거.

    목록 자체는 카탈로그 메타(이미 노출되는 이름)라 일반 사용자도 읽을 수 있다.
    수정은 관리 API(비밀번호 게이트)에서만 한다.
    """
    return {"items": list_allowed_schemas(db)}


@router.get("/hidden-schemas")
def get_hidden_schema_list(db: Session = Depends(get_db)) -> dict:
    """컬럼을 감춘 스키마 목록 + 목록 렌더 여부 — 화면이 그대로 적용한다.

    `items`는 설정(`HIDDEN_SCHEMAS`)이 원본이라 런타임에 바뀌지 않는다. `render`만
    관리 콘솔 토글이며, 꺼져 있으면 화면이 좌측 스키마·카테고리 목록과 테이블 목록에서
    해당 스키마를 통째로 뺀다.
    """
    return {
        "items": sorted(get_hidden_schemas()),
        "render": should_render_hidden_schemas(db),
    }


@router.get("/{object_id}/preview")
def get_object_preview(
    object_id: int,
    filter_column: str | None = None,
    filter_value: str | None = Query(None, max_length=100),
    # contains = LIKE '%v%'(기본), exact = 정확 일치 — 값 재검색의 매칭 방식
    filter_mode: Literal["contains", "exact"] = "contains",
    limit: int = Query(TABLE_PREVIEW_LIMIT, ge=1, le=TABLE_PREVIEW_MAX),
    db: Session = Depends(get_db),
    login_id: str = Depends(get_current_user),
) -> dict:
    """TOP 20 미리보기 — 무캐시·마스킹·감사 + 컬럼·값 재검색 (계획 §3.5 원칙 준용)."""
    obj = db.get(CatalogObject, object_id)
    if obj is None:
        raise HTTPException(404, {"message": "object not found", "context": {"object_id": object_id}})
    settings = get_settings()

    qname = f"{obj.schema}.{obj.name}"
    # 감춘 스키마는 컬럼조차 안 나가므로 값 미리보기는 당연히 막힌다 — 허용 목록에 잘못
    # 올라와 있어도 이쪽이 먼저 이긴다 / a hidden schema loses its columns, so values are
    # out of the question; this wins even if the schema was mistakenly allowlisted
    if is_schema_hidden(obj.schema):
        raise HTTPException(403, {
            "message": "this schema is hidden — its columns and values are not served "
                       "(HIDDEN_SCHEMAS)",
            "context": {"object": qname, "schema": obj.schema},
        })
    # 값 데이터를 내보내는 유일한 경로 — 스키마가 허용 목록에 없으면 소스에 질의하지 않는다
    if not is_preview_allowed(db, obj.schema):
        raise HTTPException(403, {
            "message": "preview is not allowed for this schema — an admin must add it "
                       "to the preview allowlist (관리 콘솔 → 미리보기 허용 스키마)",
            "context": {"object": qname, "schema": obj.schema},
        })

    columns = db.execute(
        select(CatalogColumn).where(CatalogColumn.object_id == obj.id)
        .order_by(CatalogColumn.ordinal)
    ).scalars().all()
    column_names = {c.name for c in columns}
    if filter_column is not None and filter_column not in column_names:
        raise HTTPException(400, {"message": "unknown filter column",
                                  "context": {"filter_column": filter_column}})
    column_specs = [{"name": c.name, "data_type": c.data_type} for c in columns]

    # live는 n8n W2 실행기, 그 외는 픽스처 합성 — 팩토리가 게이트 (docs/connect.md)
    try:
        preview = create_table_preview(settings)
    except SyntheticDataRefused as e:
        raise HTTPException(503, {"message": str(e),
                                  "context": {"source_mode": settings.source_mode}}) from e
    rows = preview.rows(
        qname, column_specs, limit,
        filter_column=filter_column, filter_value=filter_value,
        filter_mode=filter_mode,
    )

    masked = [c.name for c in columns if c.masking_policy]
    if masked:
        masked_set = set(masked)
        rows = [
            {k: ("●●●" if k in masked_set else v) for k, v in row.items()}
            for row in rows
        ]

    now = datetime.now(UTC)
    # 감사엔 매칭 방식까지 — ~ 는 부분, = 는 정확 / audit notes the match operator
    filter_op = "=" if filter_mode == "exact" else "~"
    filter_note = f" filter {filter_column}{filter_op}'{filter_value}'" if filter_column else ""
    db.add(AuditLog(action="table_preview",
                    detail=f"{qname} ({len(rows)} rows){filter_note}",
                    requested_by=login_id, requested_at=now))
    return {
        "object": qname,
        "columns": [c.name for c in columns],
        "rows": rows,
        "masked_columns": masked,
        # 0행이 나왔을 때 "원본이 비었다"와 "실행기가 안 붙었다"를 화면에서 가르는 값
        "source": "live" if settings.source_mode == "live" else "fixture",
        "limit": limit,
        "filter": (
            {"column": filter_column, "value": filter_value, "mode": filter_mode}
            if filter_column else None
        ),
        "observed_at": now.isoformat(),
    }


@router.get("/columns-index")
def get_columns_index(
    snapshot_id: int | None = None, db: Session = Depends(get_db)
) -> dict:
    """테이블별 컬럼명 인덱스 — 브라우저 컬럼 검색용 / column-name index for client search."""
    snapshot = resolve_snapshot(db, snapshot_id)
    hidden = get_hidden_schemas()
    index: dict[int, list[str]] = {}
    for object_id, schema, name in db.execute(
        select(CatalogColumn.object_id, CatalogObject.schema, CatalogColumn.name)
        .join(CatalogObject, CatalogColumn.object_id == CatalogObject.id)
        .where(CatalogObject.snapshot_id == snapshot.id, CatalogObject.type == "table")
        .order_by(CatalogColumn.object_id, CatalogColumn.ordinal)
    ):
        # 컬럼 검색 인덱스라 감춘 스키마가 남으면 이름으로 컬럼을 되찾을 수 있다
        if schema.lower() in hidden:
            continue
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


