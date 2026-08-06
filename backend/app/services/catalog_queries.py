"""Shared catalog query helpers. / 스코어링·스캔 공용 카탈로그 조회."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain import scoring
from app.models import CatalogColumn, CatalogConstraint, CatalogObject, FkColumn, ViewJoin
from app.services.schema_visibility import get_hidden_schemas


def load_scoring_columns(db: Session, snapshot_id: int) -> dict[int, scoring.ScoringColumn]:
    """스냅샷 전체 컬럼을 스코어링 입력으로 적재 / all columns as scoring inputs.

    감춘 스키마는 여기서 빠진다 — 후보 추천(columns.py)·배치 조인 체크(join_check.py)·
    T3 스캔(scan.py)·AI 제안(ai_jobs.py)이 모두 이 로더를 공유하므로, 한 곳에서 걸러야
    네 경로가 갈라지지 않는다.
    / hidden schemas drop out here: candidate scoring, the batch join check, the T3 scan
      and the AI suggester all share this loader, so filtering once keeps them in step.
    """
    hidden = get_hidden_schemas()
    rows = db.execute(
        select(CatalogColumn, CatalogObject.schema, CatalogObject.name, CatalogObject.type)
        .join(CatalogObject, CatalogColumn.object_id == CatalogObject.id)
        .where(CatalogObject.snapshot_id == snapshot_id)
    )
    return {
        col.id: scoring.ScoringColumn(
            column_id=col.id, object_qname=f"{schema}.{name}", object_type=obj_type,
            name=col.name, data_type=col.data_type, max_length=col.max_length,
            is_pk=col.is_pk, is_computed=col.is_computed, distinct_count=col.distinct_count,
        )
        for col, schema, name, obj_type in rows
        if schema.lower() not in hidden
    }


def load_pair_sets(db: Session, snapshot_id: int) -> tuple[set[frozenset], set[frozenset]]:
    """(뷰 JOIN 페어, 기존 FK 페어) / (view-join pairs, existing FK pairs)."""
    view_pairs = {
        frozenset((left, right))
        for left, right in db.execute(
            select(ViewJoin.left_column_id, ViewJoin.right_column_id)
            .where(ViewJoin.snapshot_id == snapshot_id)
        )
    }
    fk_pairs = {
        frozenset((src, tgt))
        for src, tgt in db.execute(
            select(FkColumn.src_column_id, FkColumn.tgt_column_id)
            .join(CatalogConstraint, FkColumn.constraint_id == CatalogConstraint.id)
            .where(CatalogConstraint.snapshot_id == snapshot_id)
        )
    }
    return view_pairs, fk_pairs
