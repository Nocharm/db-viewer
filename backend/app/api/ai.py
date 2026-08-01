"""AI endpoints — suggest, search, summarize. / AI 엔드포인트 (계획 Phase 5).

AI 출력은 사실로 저장하지 않는다 — 제안은 candidate/ai로만 적재되고
Phase 3 검증 큐를 거쳐야 한다 (계획 §5.2).
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session, aliased

from app.adapters.ai import (
    AiClient,
    ColumnMeta,
    TableMeta,
    ValidationFacts,
    ViewFacts,
    create_ai_client,
)
from app.api.objects import resolve_snapshot
from app.api.validate import resolve_column_ref
from app.db import get_db
from app.domain.confidence import Observation, compute_confidence
from app.models import (
    AiSummary,
    CatalogColumn,
    CatalogObject,
    JoinValidationHistory,
    Relation,
    ViewJoin,
    ViewLineageFlat,
)
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


@router.post("/explain-validation")
def explain_validation(
    src_column_id: int,
    tgt_column_id: int,
    db: Session = Depends(get_db),
    ai: AiClient = Depends(get_ai_client),
) -> dict:
    """T2 관측 통계 → 자연어 진단 — 원본 값은 입력에 없다. / narrate the latest observation."""
    src_ref, _ = resolve_column_ref(db, src_column_id)
    tgt_ref, _ = resolve_column_ref(db, tgt_column_id)
    history = db.execute(
        select(JoinValidationHistory)
        .where(
            JoinValidationHistory.src_object == src_ref.object_qname,
            JoinValidationHistory.src_column == src_ref.column,
            JoinValidationHistory.tgt_object == tgt_ref.object_qname,
            JoinValidationHistory.tgt_column == tgt_ref.column,
        )
        .order_by(JoinValidationHistory.observed_at.desc())
    ).scalars().all()
    if not history:
        raise HTTPException(404, {"message": "no validation history for this pair",
                                  "context": {"src": str(src_ref), "tgt": str(tgt_ref)}})
    latest = history[0]
    # 패턴은 이력에서 재산출 — 단일 소스는 서버 (계획 §3.4의 confidence 규칙 재사용)
    conf = compute_confidence([
        Observation(h.containment, h.src_row_count, h.observed_at) for h in history
    ])
    text = ai.explain_validation(ValidationFacts(
        src=str(src_ref), tgt=str(tgt_ref),
        containment=latest.containment,
        cardinality=latest.cardinality,
        orphan_count=latest.orphan_count,
        observation_count=len(history),
        pattern=conf.pattern,
    ))
    return {"src": str(src_ref), "tgt": str(tgt_ref), "explanation": text}


@router.post("/explain-view/{object_id}")
def explain_view(
    object_id: int,
    db: Session = Depends(get_db),
    ai: AiClient = Depends(get_ai_client),
) -> dict:
    """뷰 정의·lineage → 자연어 설명 (스키마 메타데이터만). / narrate a view's definition."""
    obj = db.get(CatalogObject, object_id)
    if obj is None or obj.type != "view":
        raise HTTPException(404, {"message": "view not found", "context": {"object_id": object_id}})
    qname = f"{obj.schema}.{obj.name}"

    base = aliased(CatalogObject)
    base_tables = sorted({
        f"{schema}.{name}"
        for schema, name in db.execute(
            select(base.schema, base.name)
            .join(ViewLineageFlat, ViewLineageFlat.base_object_id == base.id)
            .where(ViewLineageFlat.view_object_id == obj.id)
        )
    })
    left_col, right_col = aliased(CatalogColumn), aliased(CatalogColumn)
    join_pairs = [
        f"{left} = {right}"
        for left, right in db.execute(
            select(left_col.name, right_col.name)
            .select_from(ViewJoin)
            .join(left_col, ViewJoin.left_column_id == left_col.id)
            .join(right_col, ViewJoin.right_column_id == right_col.id)
            .where(ViewJoin.view_object_id == obj.id)
        )
    ]
    output_columns = [
        c.name for c in db.execute(
            select(CatalogColumn).where(CatalogColumn.object_id == obj.id)
            .order_by(CatalogColumn.ordinal)
        ).scalars()
    ]
    text = ai.explain_view(ViewFacts(
        qname=qname, base_tables=base_tables, join_pairs=join_pairs,
        output_columns=output_columns,
        definition_excerpt=(obj.definition or "")[:400] or None,
    ))
    return {"object": qname, "explanation": text}
