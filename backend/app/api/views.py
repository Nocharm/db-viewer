"""View lineage lookup. / 뷰 lineage 조회."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, aliased

from app.db import get_db
from app.models import CatalogObject, ViewDep, ViewLineageFlat
from app.services.schema_visibility import is_schema_hidden

router = APIRouter(prefix="/api/views", tags=["views"])


@router.get("/{object_id}/lineage")
def get_view_lineage(object_id: int, db: Session = Depends(get_db)) -> dict:
    view = db.get(CatalogObject, object_id)
    if view is None or view.type != "view":
        raise HTTPException(404, {"message": "view not found", "context": {"object_id": object_id}})

    base = aliased(CatalogObject)
    lineage = [
        {
            "base_object_id": row.base_object_id,
            "base": f"{b_schema}.{b_name}" if b_schema else None,
            "base_column": row.base_column, "depth": row.depth,
            "mapping_kind": row.mapping_kind, "flag": row.flag,
        }
        for row, b_schema, b_name in db.execute(
            select(ViewLineageFlat, base.schema, base.name)
            .outerjoin(base, ViewLineageFlat.base_object_id == base.id)
            .where(ViewLineageFlat.view_object_id == view.id)
            .order_by(ViewLineageFlat.depth, ViewLineageFlat.id)
        )
    ]
    unresolved = [
        {
            "referenced_database": dep.referenced_database,
            "referenced_name": dep.referenced_name,
            "referenced_column": dep.referenced_column,
        }
        for dep in db.execute(
            select(ViewDep)
            .where(ViewDep.view_object_id == view.id, ViewDep.is_resolved.is_(False))
        ).scalars()
    ]
    return {
        "view": {"id": view.id, "schema": view.schema, "name": view.name,
                 "dmv_unresolved": view.dmv_unresolved,
                 "has_definition": view.definition is not None},
        "lineage": lineage,
        "unresolved_deps": unresolved,
    }


@router.get("/{object_id}/definition")
def get_view_definition(object_id: int, db: Session = Depends(get_db)) -> dict:
    """뷰 정의 SQL — 구조 정보라 미리보기 허용 목록·감사와 무관하지만, 숨김 스키마는 컬럼처럼 감춘다.

    definition이 NULL이면 수집 시 VIEW DEFINITION 권한이 없었던 것 — 오류가 아니라 상태다.
    / structure, not values: hidden-schema gate only; NULL means permission-blocked at collect time.
    """
    view = db.get(CatalogObject, object_id)
    if view is None or view.type != "view":
        raise HTTPException(404, {"message": "view not found", "context": {"object_id": object_id}})
    if is_schema_hidden(view.schema):
        raise HTTPException(403, {
            "message": "this schema is hidden — its columns and definitions are not served "
                       "(HIDDEN_SCHEMAS)",
            "context": {"object": f"{view.schema}.{view.name}", "schema": view.schema},
        })
    return {
        "object_id": view.id,
        "object": f"{view.schema}.{view.name}",
        "definition": view.definition,
        "parse_status": view.parse_status,
    }
