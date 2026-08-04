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
    CandidatePair,
    ColumnMeta,
    TableMeta,
    ValidationFacts,
    ViewFacts,
    create_ai_client,
)
from app.api.objects import resolve_snapshot
from app.api.validate import resolve_column_ref
from app.config import get_settings
from app.db import get_db
from app.domain import scoring
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


def select_ai_candidates(
    columns: dict[int, scoring.ScoringColumn],
    view_pairs: set[frozenset],
    fk_pairs: set[frozenset],
    min_distinct: int,
    blacklist: set[str],
    max_pairs: int,
    existing: set[tuple[str, str, str, str]],
) -> list[tuple[scoring.ScoringColumn, scoring.Candidate]]:
    """스냅샷 전체 상위 후보 — 무순서 페어당 고점 방향 1건.

    후보 우주는 뷰 JOIN 페어 + 정규화 동명 컬럼↔PK 페어로 한정한다.
    전 컬럼 O(N²) 스코어링은 실 규모(2,342 테이블)에서 불가능하고,
    스코어러 신호 자체가 이 두 우주 밖에서는 0점이라 손실도 없다
    (비PK↔비PK 동명 페어만 제외되는데, 그쪽은 컬럼 단위 후보 API가 커버).

    기존 관계 제거(existing, 양방향 채움은 호출측 책임)는 max_pairs 상한 **전**에
    적용한다 — 순서가 반대면 재실행마다 같은 상위 페어만 뽑혀 전량 걸러지고
    다음 순위 후보는 영원히 도달 불가해진다 (재실행 페이징 계약).
    """
    all_columns = list(columns.values())
    pairs: set[frozenset] = {p for p in view_pairs if len(p) == 2}
    pk_index: dict[str, list[scoring.ScoringColumn]] = {}
    for col in all_columns:
        if col.is_pk:
            pk_index.setdefault(scoring.normalize_name(col.name), []).append(col)
    for col in all_columns:
        for pk in pk_index.get(scoring.normalize_name(col.name), []):
            if pk.object_qname != col.object_qname:
                pairs.add(frozenset((col.column_id, pk.column_id)))

    best: dict[frozenset, tuple[scoring.ScoringColumn, scoring.Candidate]] = {}
    for pair in pairs:
        ids = tuple(pair)
        for src_id, tgt_id in (ids, ids[::-1]):
            src, tgt = columns.get(src_id), columns.get(tgt_id)
            if src is None or tgt is None:
                continue
            if scoring.check_exclusion(src, min_distinct, blacklist) is not None:
                continue
            for cand in scoring.score_candidates(
                src, [tgt], view_pairs, fk_pairs, min_distinct, blacklist
            ):
                if pair not in best or cand.score > best[pair][1].score:
                    best[pair] = (src, cand)
    filtered = [
        (src, cand) for src, cand in best.values()
        if (src.object_qname, src.name, cand.target.object_qname, cand.target.name)
        not in existing
    ]
    ranked = sorted(filtered, key=lambda p: (-p[1].score, p[0].object_qname, p[0].name))
    return ranked[:max_pairs]


@router.post("/suggest-relations")
def suggest_relations(
    snapshot_id: int | None = None,
    db: Session = Depends(get_db),
    ai: AiClient = Depends(get_ai_client),
) -> dict:
    """AI 관계 후보 생성 → 검증 큐 직행 (candidate/ai — confirmed 금지). / suggestions to the queue."""
    snapshot = resolve_snapshot(db, snapshot_id)
    settings = get_settings()
    columns = load_scoring_columns(db, snapshot.id)
    view_pairs, fk_pairs = load_pair_sets(db, snapshot.id)

    # 기존 관계와 중복 제거(양방향) — 상한 적용 전에 걸러야 재실행마다 다음 순위
    # 후보가 올라온다(순서가 반대면 매번 같은 상위 40건만 뽑혀 걸러진다)
    existing: set[tuple] = set()
    for r in db.execute(select(Relation)).scalars():
        existing.add((r.src_object, r.src_column, r.tgt_object, r.tgt_column))
        existing.add((r.tgt_object, r.tgt_column, r.src_object, r.src_column))

    ranked = select_ai_candidates(
        columns, view_pairs, fk_pairs,
        settings.low_cardinality_min_distinct,
        {b.upper() for b in settings.low_cardinality_blacklist},
        settings.ai_suggest_max_pairs,
        existing,
    )

    row_counts = {
        f"{o.schema}.{o.name}": o.row_count
        for o in db.execute(
            select(CatalogObject).where(CatalogObject.snapshot_id == snapshot.id)
        ).scalars()
    }
    pairs_meta = []
    for src, cand in ranked:
        tgt = cand.target
        pairs_meta.append(CandidatePair(
            src_object=src.object_qname, src_column=src.name,
            src_type=src.data_type, src_is_pk=src.is_pk,
            src_row_count=row_counts.get(src.object_qname),
            tgt_object=tgt.object_qname, tgt_column=tgt.name,
            tgt_type=tgt.data_type, tgt_is_pk=tgt.is_pk,
            tgt_row_count=row_counts.get(tgt.object_qname),
            score=cand.score, signals=sorted(cand.signals),
        ))

    suggestions = ai.judge_relations(pairs_meta)

    now = datetime.now(UTC)
    created = []
    for s in suggestions:
        key = (s.src_object, s.src_column, s.tgt_object, s.tgt_column)
        db.add(Relation(
            src_object=s.src_object, src_column=s.src_column,
            tgt_object=s.tgt_object, tgt_column=s.tgt_column,
            status="candidate", origin="ai", created_at=now,
        ))
        created.append({**key_as_dict(key), "reason": s.reason})
    return {"snapshot_id": snapshot.id, "suggested": len(pairs_meta),
            "created": len(created), "items": created[:100]}


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
