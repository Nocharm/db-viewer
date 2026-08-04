"""Relation candidate scoring — Phase 3 (계획 §3.1). / 관계 후보 스코어링 (순수 로직).

AI는 후보를 제안하고 SQL이 판정한다 — 점수는 검증 우선순위일 뿐 사실이 아니다.
Scores rank verification priority; they are never facts.
"""

from dataclasses import dataclass

# 신호 가중치 (계획 §3.1) — 뷰 JOIN이 최상, 명명 상, 키(인덱스 근사) 중
WEIGHT_VIEW_JOIN = 100
WEIGHT_NAMING_EXACT = 40
WEIGHT_NAMING_NORMALIZED = 32  # EMP_NO ↔ EMPNO 류 변형
WEIGHT_KEY = 20  # UQ 멤버십은 카탈로그에 없어 PK만 인덱스 존재 근사로 사용

_INT_FAMILY = {"tinyint", "smallint", "int", "bigint"}
_CHAR_FAMILY = {"char", "varchar", "nchar", "nvarchar"}


@dataclass(frozen=True)
class ScoringColumn:
    column_id: int
    object_qname: str
    object_type: str
    name: str
    data_type: str
    max_length: int
    is_pk: bool
    is_computed: bool
    distinct_count: int | None


@dataclass
class Candidate:
    target: ScoringColumn
    score: int
    signals: dict


def check_exclusion(
    col: ScoringColumn, min_distinct: int, blacklist: set[str]
) -> str | None:
    """검증 제외 사유 — UI가 배지·사유로 노출 (계획 §3.3). / exclusion reason or None."""
    if col.is_computed:
        return "computed"  # 계산 컬럼은 관계 추론 제외 (계획 §1.3)
    if col.object_type != "table":
        return "not_a_table"
    if col.name.upper() in blacklist:
        return "blacklist"
    if col.distinct_count is not None and col.distinct_count < min_distinct:
        return "low_distinct"
    return None


def is_type_compatible(src: ScoringColumn, tgt: ScoringColumn) -> bool:
    """containment은 src ⊆ tgt 전제 — 타입·길이 필터 (계획 §3.1)."""
    if src.data_type in _INT_FAMILY and tgt.data_type in _INT_FAMILY:
        return True
    if src.data_type in _CHAR_FAMILY and tgt.data_type in _CHAR_FAMILY:
        return tgt.max_length >= src.max_length or tgt.max_length == -1
    return src.data_type == tgt.data_type and src.max_length == tgt.max_length


def normalize_name(name: str) -> str:
    return name.replace("_", "").upper()


def score_candidates(
    src: ScoringColumn,
    targets: list[ScoringColumn],
    view_join_pairs: set[frozenset[int]],
    existing_fk_pairs: set[frozenset[int]],
    min_distinct: int,
    blacklist: set[str],
) -> list[Candidate]:
    candidates = []
    for tgt in targets:
        if tgt.column_id == src.column_id or tgt.object_qname == src.object_qname:
            continue
        if check_exclusion(tgt, min_distinct, blacklist) is not None:
            continue  # 함정 타깃도 걸러야 1.0 노이즈가 안 생긴다 / trap targets too
        if not is_type_compatible(src, tgt):
            continue
        pair = frozenset((src.column_id, tgt.column_id))
        if pair in existing_fk_pairs:
            continue  # 이미 FK — 발견 대상 아님 / already constrained

        signals: dict = {}
        if pair in view_join_pairs:
            signals["view_join"] = WEIGHT_VIEW_JOIN
        if src.name == tgt.name:
            signals["naming"] = WEIGHT_NAMING_EXACT
        elif normalize_name(src.name) == normalize_name(tgt.name):
            signals["naming"] = WEIGHT_NAMING_NORMALIZED
        # 키 보너스는 단독 신호가 아니다 — PK 전수가 후보가 되는 노이즈 방지
        # key bonus never stands alone; every PK would be a candidate otherwise
        if not signals:
            continue
        if tgt.is_pk:
            signals["key"] = WEIGHT_KEY

        candidates.append(Candidate(tgt, sum(signals.values()), signals))

    candidates.sort(key=lambda c: (-c.score, c.target.object_qname, c.target.name))
    return candidates
