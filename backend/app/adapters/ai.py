"""AI client adapter — metadata in, suggestions out. / AI 어댑터 (계획 Phase 5).

원칙: AI는 후보를 제안하고 SQL이 판정한다. 인터페이스가 메타데이터 타입만 받으므로
원본 데이터 값이 프롬프트로 샐 경로가 구조적으로 없다 (계획 §5.2 금지 대응).
The interface accepts only metadata types, so raw values cannot leak
into prompts by construction. Real LLM provider lands at the connection
stage; the fake keeps every feature testable offline.
"""

from dataclasses import dataclass, field
from typing import Protocol


@dataclass(frozen=True)
class ColumnMeta:
    name: str
    data_type: str
    is_pk: bool = False


@dataclass(frozen=True)
class TableMeta:
    qname: str
    columns: list[ColumnMeta] = field(default_factory=list)
    row_count: int | None = None


@dataclass(frozen=True)
class AiRelationSuggestion:
    src_object: str
    src_column: str
    tgt_object: str
    tgt_column: str
    reason: str


@dataclass(frozen=True)
class AiTableHit:
    qname: str
    score: float
    reason: str


class AiClient(Protocol):
    def suggest_relations(self, tables: list[TableMeta]) -> list[AiRelationSuggestion]: ...

    def search_tables(self, query: str, tables: list[TableMeta]) -> list[AiTableHit]: ...

    def summarize_table(self, table: TableMeta, base_tables: list[str]) -> str: ...


def _normalize(name: str) -> str:
    return name.replace("_", "").upper()


class FakeAiClient:
    """결정론적 휴리스틱 — 실제 LLM의 퍼지 매칭을 흉내 / deterministic stand-in."""

    def suggest_relations(self, tables: list[TableMeta]) -> list[AiRelationSuggestion]:
        # PK 이름 인덱스 → 다른 테이블의 유사 컬럼 탐색 (EMP_NO ↔ EMPNO 류)
        pk_index: dict[str, tuple[str, str]] = {}
        for table in tables:
            for col in table.columns:
                if col.is_pk:
                    pk_index.setdefault(_normalize(col.name), (table.qname, col.name))
        suggestions = []
        for table in tables:
            for col in table.columns:
                if col.is_pk:
                    continue
                hit = pk_index.get(_normalize(col.name))
                if hit and hit[0] != table.qname:
                    suggestions.append(AiRelationSuggestion(
                        src_object=table.qname, src_column=col.name,
                        tgt_object=hit[0], tgt_column=hit[1],
                        reason=f"name affinity: {col.name} ~ {hit[1]}",
                    ))
        return sorted(suggestions, key=lambda s: (s.src_object, s.src_column))

    def search_tables(self, query: str, tables: list[TableMeta]) -> list[AiTableHit]:
        terms = [t for t in _normalize(query).split() if t] or [_normalize(query)]
        hits = []
        for table in tables:
            haystack = _normalize(table.qname) + " " + " ".join(
                _normalize(c.name) for c in table.columns
            )
            matched = [t for t in terms if t and t in haystack]
            if matched:
                hits.append(AiTableHit(
                    qname=table.qname, score=round(len(matched) / len(terms), 2),
                    reason=f"matched: {', '.join(matched)}",
                ))
        hits.sort(key=lambda h: (-h.score, h.qname))
        return hits[:20]

    def summarize_table(self, table: TableMeta, base_tables: list[str]) -> str:
        pk = next((c.name for c in table.columns if c.is_pk), None)
        head = ", ".join(c.name for c in table.columns[:5])
        summary = f"{table.qname} — 주요 컬럼: {head}"
        if pk:
            summary += f" (키: {pk})"
        if base_tables:
            summary += f" / 원천: {', '.join(base_tables[:3])}"
        return summary


def create_ai_client() -> AiClient:
    """실제 프로바이더 연결 전까지 Fake 고정 (연결 단계 결정 사항). / fake until connection stage."""
    return FakeAiClient()
