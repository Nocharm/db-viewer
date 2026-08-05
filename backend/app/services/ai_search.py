"""Two-stage table search — embedding first, keyword fallback. / 의미 검색 + 폴백 (사이클2 §3)."""

import json
import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.adapters.ai import AiClient, AiTableHit, TableMeta
from app.adapters.llm_ai import (
    AiUnavailableError,
    LlmAiClient,
    cosine_similarity,
    embed_texts,
)
from app.config import Settings
from app.models import AiEmbedding

logger = logging.getLogger(__name__)

# 임베딩 프리필터 상한 — 키워드 경로의 50과 동일한 재랭크 입력 크기
EMBED_TOP_K = 50


def rank_by_cosine(query_vec: list[float], rows: list[tuple[str, list[float]]],
                   top_k: int) -> list[str]:
    """(qname, vector) 목록을 코사인 내림차순 상위 top_k qname으로 / pure ranking."""
    scored = [(cosine_similarity(query_vec, vec), qname) for qname, vec in rows]
    scored.sort(key=lambda pair: (-pair[0], pair[1]))
    return [qname for _, qname in scored[:top_k]]


def search_tables_smart(db: Session, query: str, tables: list[TableMeta],
                        ai: AiClient, settings: Settings) -> tuple[str, list[AiTableHit]]:
    """임베딩 가용이면 의미 검색, 아니면(또는 후보 선정에 실패하면) 키워드 폴백.

    폴백은 에러가 아니다 — 후보 선정이 임베딩 문제로 502가 되지 않는 것이 계약.
    단, rerank_tables(실제 LLM 호출)는 try 밖에서 호출한다 — 재랭크 실패까지
    폴백으로 삼으면 순수 의미 질의에서 LLM 장애가 200 빈 결과로 은폐된다.
    """
    candidates: list[TableMeta] | None = None
    if settings.ai_embed_model and isinstance(ai, LlmAiClient):
        try:
            rows: list[tuple[str, list[float]]] = []
            for e in db.execute(
                select(AiEmbedding).where(AiEmbedding.model == settings.ai_embed_model)
            ).scalars():
                try:
                    rows.append((e.object_qname, json.loads(e.vector)))
                except (json.JSONDecodeError, TypeError):
                    # 손상 행은 스킵 — 인덱스 일부 손상이 검색 전체를 죽이면 안 된다
                    logger.warning("skipping corrupt embedding row",
                                   extra={"qname": e.object_qname})
            if rows:
                query_vec = embed_texts(
                    settings.ai_base_url, settings.ai_embed_model,
                    settings.ai_api_key, settings.ai_timeout, [query],
                )[0]
                by_qname = {t.qname: t for t in tables}
                selected = [
                    by_qname[qname]
                    for qname in rank_by_cosine(query_vec, rows, EMBED_TOP_K)
                    if qname in by_qname
                ]
                if selected:
                    candidates = selected
        except AiUnavailableError as e:
            # 임베딩 실패만 폴백 신호 — 재랭크 실패는 아래에서 502로 전파된다
            logger.warning("embedding search unavailable, falling back",
                           extra={"cause": str(e)})
    if candidates is not None:
        return "embedding", ai.rerank_tables(query, candidates)
    return "keyword", ai.search_tables(query, tables)
