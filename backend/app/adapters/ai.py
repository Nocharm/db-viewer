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


@dataclass(frozen=True)
class ValidationFacts:
    """T2 관측 통계만 — 원본 값 없음 / observation stats only, never raw values."""

    src: str
    tgt: str
    containment: float
    cardinality: str | None
    orphan_count: int
    observation_count: int
    pattern: str


@dataclass(frozen=True)
class ViewFacts:
    """뷰 정의(DDL 텍스트)와 lineage — 스키마 메타데이터 / schema metadata of a view."""

    qname: str
    base_tables: list[str]
    join_pairs: list[str]
    output_columns: list[str]
    definition_excerpt: str | None


class AiClient(Protocol):
    def suggest_relations(self, tables: list[TableMeta]) -> list[AiRelationSuggestion]: ...

    def search_tables(self, query: str, tables: list[TableMeta]) -> list[AiTableHit]: ...

    def summarize_table(self, table: TableMeta, base_tables: list[str]) -> str: ...

    def explain_validation(self, facts: ValidationFacts) -> str: ...

    def explain_view(self, facts: ViewFacts) -> str: ...


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

    # 패턴 라벨 → 진단 문장 골격 / diagnosis skeleton per confidence pattern
    _PATTERN_NOTES = {
        "stable_confirmed": "관측이 반복적으로 1.0 — 사실상 FK로 봐도 무방합니다.",
        "stable_with_orphans": "관계는 유효하나 고아 행이 남습니다 — 마스터 삭제 이력이나 이관 잔여일 가능성이 큽니다.",
        "drop_alert": "직전 관측 대비 급락 — 스키마 변경이나 데이터 이관을 의심하고 원인 확인이 필요합니다.",
        "small_sample_only": "행 수가 적어 우연 일치 가능성을 배제할 수 없습니다 — 데이터가 쌓인 뒤 재검증을 권합니다.",
        "unstable": "관측마다 값이 흔들립니다 — 관계로 확정하기 전 원인 파악이 필요합니다.",
    }

    def explain_validation(self, facts: ValidationFacts) -> str:
        pct = f"{facts.containment * 100:.1f}%"
        head = f"{facts.src} → {facts.tgt}: 포함률 {pct}"
        if facts.cardinality == "N:M":
            head += ", N:M 교차 관계라 FK 후보는 아닙니다"
        elif facts.cardinality:
            head += f", {facts.cardinality}"
        body = self._PATTERN_NOTES.get(facts.pattern, "패턴 미분류 — 관측을 더 쌓아 주세요.")
        orphan = (
            f" 고아 {facts.orphan_count}건은 타깃에 없는 소스 값입니다."
            if facts.orphan_count > 0 else ""
        )
        return f"{head}. {body}{orphan} (관측 {facts.observation_count}회 기준)"

    def explain_view(self, facts: ViewFacts) -> str:
        parts = [f"{facts.qname}"]
        if facts.base_tables:
            parts.append(f"{', '.join(facts.base_tables[:4])}을(를) 원천으로")
        if facts.join_pairs:
            parts.append(f"{', '.join(facts.join_pairs[:3])} 조건으로 조인해")
        head = ", ".join(facts.output_columns[:5])
        parts.append(f"{head} 등 {len(facts.output_columns)}개 컬럼을 노출하는 뷰입니다.")
        if facts.definition_excerpt and "GROUP BY" in facts.definition_excerpt.upper():
            parts.append("집계(GROUP BY)를 포함합니다.")
        return " ".join(parts)


def create_ai_client() -> AiClient:
    """실제 프로바이더 연결 전까지 Fake 고정 (연결 단계 결정 사항). / fake until connection stage."""
    return FakeAiClient()
