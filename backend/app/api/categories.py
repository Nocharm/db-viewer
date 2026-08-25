"""Schema→category mapping API. / 스키마(DB)별 카테고리 매핑 API.

실 스키마가 DB 단위(ATM·BCMS·SAP…)라 분류도 스키마 단위다 — 한 스키마의 카테고리를
바꾸면 그 DB의 테이블이 통째로 함께 옮겨간다(일괄 이동). 매핑이 없는 스키마는
스키마명 자체가 카테고리라, 아무 설정 없이도 목록이 채워진다.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.objects import resolve_snapshot
from app.auth import get_current_user
from app.db import get_db
from app.models import CatalogObject, SchemaCategory

router = APIRouter(prefix="/api/schema-categories", tags=["categories"])


class CategoryAssignment(BaseModel):
    # 빈 문자열은 매핑 해제 — 기본값(스키마명)으로 되돌린다
    category: str = Field(default="", max_length=100)


@router.get("")
def list_schema_categories(
    snapshot_id: int | None = None, source_id: int | None = None,
    db: Session = Depends(get_db),
) -> dict:
    """스냅샷의 스키마 목록 + 지정된 카테고리(없으면 스키마명) + 객체 수."""
    snapshot = resolve_snapshot(db, snapshot_id, source_id)
    counts = db.execute(
        select(CatalogObject.schema, func.count())
        .where(CatalogObject.snapshot_id == snapshot.id)
        .group_by(CatalogObject.schema)
        .order_by(CatalogObject.schema)
    ).all()
    # 매핑도 소스별이다 — 다른 소스의 동명 스키마 카테고리가 섞여 들어오면 안 된다
    mapped = {
        row.schema_name: row.category
        for row in db.execute(
            select(SchemaCategory)
            .where(SchemaCategory.data_source_id == snapshot.data_source_id)
        ).scalars()
    }
    return {
        "snapshot_id": snapshot.id,
        "source_id": snapshot.data_source_id,
        "items": [
            {
                "schema": schema,
                "category": mapped.get(schema, schema),
                # 사용자가 지정한 값인지 — 화면에서 기본값과 구분해 보여준다
                "mapped": schema in mapped,
                "object_count": count,
            }
            for schema, count in counts
        ],
    }


@router.put("/{schema_name}")
def assign_schema_category(
    schema_name: str,
    body: CategoryAssignment,
    source_id: int | None = None,
    db: Session = Depends(get_db),
    login_id: str = Depends(get_current_user),
) -> dict:
    """스키마 하나의 카테고리 지정·해제 — 그 DB의 테이블이 통째로 이동한다."""
    snapshot = resolve_snapshot(db, snapshot_id=None, source_id=source_id)
    exists = db.execute(
        select(CatalogObject.id)
        .where(CatalogObject.snapshot_id == snapshot.id,
               CatalogObject.schema == schema_name)
        .limit(1)
    ).scalar_one_or_none()
    if exists is None:
        # 오타로 유령 매핑이 쌓이면 목록에 안 보이는 쓰레기가 남는다
        raise HTTPException(400, {"message": "unknown schema in the latest snapshot",
                                  "context": {"schema": schema_name}})

    row = db.get(SchemaCategory, (snapshot.data_source_id, schema_name))
    category = body.category.strip()
    if not category:
        if row is not None:
            db.delete(row)
        return {"schema": schema_name, "category": schema_name, "mapped": False}

    if row is None:
        db.add(SchemaCategory(data_source_id=snapshot.data_source_id,
                              schema_name=schema_name, category=category,
                              updated_by=login_id, updated_at=datetime.now(UTC)))
    else:
        row.category = category
        row.updated_by = login_id
        row.updated_at = datetime.now(UTC)
    return {"schema": schema_name, "category": category, "mapped": True}
