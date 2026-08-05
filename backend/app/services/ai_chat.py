"""Schema Q&A context builder — search-driven table context for chat. / 챗 컨텍스트 조립 (사이클2 §4).

search_tables_smart의 히트(top-8)를 컬럼·요약·관계·lineage로 확장해 프롬프트 페이로드를
만든다. 히트가 비면 빈 컨텍스트를 반환 — Fake/Llm 모두 "관련 테이블 없음" 경로로 응답한다.
"""

from sqlalchemy import or_, select
from sqlalchemy.orm import Session, aliased

from app.adapters.ai import AiClient, ChatContext, ChatTableContext, TableMeta
from app.config import Settings
from app.models import AiSummary, CatalogObject, Relation, ViewLineageFlat
from app.services.ai_search import search_tables_smart

# 챗 컨텍스트에 싣는 테이블 수 상한 — 프롬프트 크기 제어 (비즈니스 상수)
CHAT_TOP_K = 8
# 테이블당 관계 문자열 상한 — 관계가 많은 허브 테이블의 프롬프트 폭주 방지
CHAT_RELATIONS_LIMIT = 10
# 챗 컨텍스트에 싣는 관계 상태 — validated(T2 통과)·confirmed(사용자 확정)만
_CHAT_RELATION_STATUSES = ("validated", "confirmed")


def build_chat_context(
    db: Session, snapshot_id: int, query: str, tables: list[TableMeta],
    ai: AiClient, settings: Settings,
) -> ChatContext:
    """search_tables_smart 재사용 top-8 → 컬럼·요약·관계·lineage 결합 / assembles chat context.

    snapshot_id는 qname→object_id 해석(lineage 역추적)에만 쓰인다.
    """
    _, hits = search_tables_smart(db, query, tables, ai, settings)
    if not hits:
        return ChatContext(tables=[])

    qnames = [h.qname for h in hits[:CHAT_TOP_K]]
    by_qname = {t.qname: t for t in tables}
    # api/ai.py search_tables의 기존 관용 — snapshot 내 qname→object_id 매핑
    id_by_qname = {
        f"{o.schema}.{o.name}": o.id
        for o in db.execute(
            select(CatalogObject).where(CatalogObject.snapshot_id == snapshot_id)
        ).scalars()
    }
    summary_by_qname = {
        s.object_qname: s.summary
        for s in db.execute(
            select(AiSummary).where(AiSummary.object_qname.in_(qnames))
        ).scalars()
    }

    chat_tables = []
    for qname in qnames:
        table = by_qname.get(qname)
        if table is None:
            continue  # 검색 히트가 tables 스냅샷 밖 — 경합 등 방어

        relations = [
            f"{r.src_object}.{r.src_column} → {r.tgt_object}.{r.tgt_column} ({r.status})"
            for r in db.execute(
                select(Relation)
                .where(
                    Relation.status.in_(_CHAT_RELATION_STATUSES),
                    or_(Relation.src_object == qname, Relation.tgt_object == qname),
                )
                .order_by(Relation.id)
                .limit(CHAT_RELATIONS_LIMIT)
            ).scalars()
        ]

        # api/ai.py summarize_object/explain_view의 기존 lineage 역추적 쿼리 관용 재사용
        base_tables: list[str] = []
        object_id = id_by_qname.get(qname)
        if object_id is not None:
            base = aliased(CatalogObject)
            base_tables = sorted({
                f"{schema}.{name}"
                for schema, name in db.execute(
                    select(base.schema, base.name)
                    .join(ViewLineageFlat, ViewLineageFlat.base_object_id == base.id)
                    .where(ViewLineageFlat.view_object_id == object_id)
                )
            })

        chat_tables.append(ChatTableContext(
            qname=qname, columns=table.columns,
            summary=summary_by_qname.get(qname),
            relations=relations, base_tables=base_tables,
        ))
    return ChatContext(tables=chat_tables)
