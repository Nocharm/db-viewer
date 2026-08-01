"""AI endpoints — suggest, search, summarize. / AI 엔드포인트 (계획 Phase 5).

AI 출력은 사실로 저장하지 않는다 — 제안은 candidate/ai로만 적재되고
Phase 3 검증 큐를 거쳐야 한다 (계획 §5.2).
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session, aliased

from app.adapters.ai import AiClient, ColumnMeta, TableMeta, create_ai_client
from app.api.objects import resolve_snapshot
from app.db import get_db
from app.models import AiSummary, CatalogColumn, CatalogObject, Relation, ViewLineageFlat
from app.services.catalog_queries import load_pair_sets, load_scoring_columns

router = APIRouter(prefix="/api/ai", tags=["ai"])


def get_ai_client() -> AiClient:
    return create_ai_client()


def _load_table_meta(db: Session, snapshot_id: int) -> list[TableMeta]:
    """메타데이터만 적재 — 값 접근 없음 (계획 §5.1-1) / metadata only, never values."""
    columns_by_object: dict[int, list[ColumnMeta]] = {}
    for col in db.execute(
        select(CatalogColumn)
        .join(CatalogObject, CatalogColumn.object_id == CatalogObject.id)
        .where(CatalogObject.snapshot_id == snapshot_id, CatalogObject.type == "table")
        .order_by(CatalogColumn.object_id, CatalogColumn.ordinal)
    ).scalars():
        columns_by_object.setdefault(col.object_id, []).append(
            ColumnMeta(col.name, col.data_type, col.is_pk)
        )
    return [
        TableMeta(
            qname=f"{obj.schema}.{obj.name}",
            columns=columns_by_object.get(obj.id, []),
            row_count=obj.row_count,
        )
        for obj in db.execute(
            select(CatalogObject)
            .where(CatalogObject.snapshot_id == snapshot_id, CatalogObject.type == "table")
            .order_by(CatalogObject.schema, CatalogObject.name)
        ).scalars()
    ]


@router.post("/suggest-relations")
def suggest_relations(
    snapshot_id: int | None = None,
    db: Session = Depends(get_db),
    ai: AiClient = Depends(get_ai_client),
) -> dict:
    """AI 관계 후보 생성 → 검증 큐 직행 (candidate/ai — confirmed 금지). / suggestions to the queue."""
    snapshot = resolve_snapshot(db, snapshot_id)
    tables = _load_table_meta(db, snapshot.id)
    suggestions = ai.suggest_relations(tables)

    # 기존 FK·관계와 중복 제거 / dedupe against FKs and known relations
    columns = load_scoring_columns(db, snapshot.id)
    by_identity = {(c.object_qname, c.name): c.column_id for c in columns.values()}
    _, fk_pairs = load_pair_sets(db, snapshot.id)
    existing = {
        (r.src_object, r.src_column, r.tgt_object, r.tgt_column)
        for r in db.execute(select(Relation)).scalars()
    }

    now = datetime.now(UTC)
    created = []
    for s in suggestions:
        key = (s.src_object, s.src_column, s.tgt_object, s.tgt_column)
        if key in existing:
            continue
        src_id = by_identity.get((s.src_object, s.src_column))
        tgt_id = by_identity.get((s.tgt_object, s.tgt_column))
        if src_id is None or tgt_id is None:
            continue
        if frozenset((src_id, tgt_id)) in fk_pairs:
            continue  # 이미 FK / already constrained
        db.add(Relation(
            src_object=s.src_object, src_column=s.src_column,
            tgt_object=s.tgt_object, tgt_column=s.tgt_column,
            status="candidate", origin="ai", created_at=now,
        ))
        created.append({**key_as_dict(key), "reason": s.reason})
    return {"snapshot_id": snapshot.id, "suggested": len(suggestions), "created": len(created),
            "items": created[:100]}


def key_as_dict(key: tuple) -> dict:
    return {"src_object": key[0], "src_column": key[1],
            "tgt_object": key[2], "tgt_column": key[3]}


@router.get("/search-tables")
def search_tables(
    q: str = Query(min_length=2),
    snapshot_id: int | None = None,
    db: Session = Depends(get_db),
    ai: AiClient = Depends(get_ai_client),
) -> dict:
    """자연어 테이블 탐색 (계획 §5.1-2). / natural-language table search."""
    snapshot = resolve_snapshot(db, snapshot_id)
    hits = ai.search_tables(q, _load_table_meta(db, snapshot.id))
    id_by_qname = {
        f"{o.schema}.{o.name}": o.id
        for o in db.execute(
            select(CatalogObject).where(CatalogObject.snapshot_id == snapshot.id)
        ).scalars()
    }
    return {"snapshot_id": snapshot.id, "items": [
        {"object_id": id_by_qname.get(h.qname), "object": h.qname,
         "score": h.score, "reason": h.reason}
        for h in hits
    ]}


@router.post("/summarize/{object_id}")
def summarize_object(
    object_id: int,
    force: bool = False,
    db: Session = Depends(get_db),
    ai: AiClient = Depends(get_ai_client),
) -> dict:
    """도메인 요약 생성·캐시 → ERD 툴팁 (계획 §5.1-3). / cached one-line summary."""
    obj = db.get(CatalogObject, object_id)
    if obj is None:
        raise HTTPException(404, {"message": "object not found", "context": {"object_id": object_id}})
    qname = f"{obj.schema}.{obj.name}"

    cached = db.execute(
        select(AiSummary).where(AiSummary.object_qname == qname)
    ).scalar_one_or_none()
    if cached is not None and not force:
        return {"object": qname, "summary": cached.summary, "cached": True}

    columns = [
        ColumnMeta(c.name, c.data_type, c.is_pk)
        for c in db.execute(
            select(CatalogColumn).where(CatalogColumn.object_id == obj.id)
            .order_by(CatalogColumn.ordinal)
        ).scalars()
    ]
    base = aliased(CatalogObject)
    base_tables = sorted({
        f"{schema}.{name}"
        for schema, name in db.execute(
            select(base.schema, base.name)
            .join(ViewLineageFlat, ViewLineageFlat.base_object_id == base.id)
            .where(ViewLineageFlat.view_object_id == obj.id)
        )
    })
    summary = ai.summarize_table(TableMeta(qname, columns, obj.row_count), base_tables)

    if cached is None:
        db.add(AiSummary(object_qname=qname, summary=summary, created_at=datetime.now(UTC)))
    else:
        cached.summary = summary
        cached.created_at = datetime.now(UTC)
    return {"object": qname, "summary": summary, "cached": False}
