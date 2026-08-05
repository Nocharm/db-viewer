"""JoinValidator abstraction — the real DB lives only behind this. / 검증 실행기 추상화 (계획 §4.3)."""

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class ColumnRef:
    """검증 대상 컬럼의 텍스트 식별자 — 스냅샷에 독립 / textual identity, snapshot-independent."""

    schema: str
    table: str
    column: str

    @property
    def object_qname(self) -> str:
        return f"{self.schema}.{self.table}"

    def __str__(self) -> str:
        return f"{self.object_qname}.{self.column}"


@dataclass(frozen=True)
class ContainmentResult:
    """containment = |A ∩ B| / |A| — Jaccard 아님 (계획 §3.2). / not Jaccard by design."""

    src_distinct: int
    matched: int
    containment: float
    orphan_count: int
    src_row_count: int
    tgt_distinct: int
    tgt_row_count: int

    @property
    def cardinality(self) -> str:
        # 타깃 유니크 여부로 판정 — N:M은 FK가 아니라 교차 관계 (계획 §3.2)
        return "1:N" if self.tgt_distinct >= self.tgt_row_count else "N:M"


class ValidationDataMissing(LookupError):
    """값 집합·테이블 접근 불가 — 검증 불가. / no data available for this column."""

    def __init__(self, ref: ColumnRef):
        super().__init__(f"no value data for {ref}")
        self.ref = ref


@dataclass(frozen=True)
class JoinStepRef:
    """N-웨이 조인 한 단계 — 스냅샷 독립 텍스트 식별자 / one join step, snapshot-free."""

    left_schema: str
    left_table: str
    left_column: str
    right_schema: str
    right_table: str
    right_column: str
    join_type: str  # "inner" | "left"


class JoinValidator(Protocol):
    """실DB는 이 인터페이스 뒤에만 존재한다 / real DB lives only behind this (계획 §4.3)."""

    def containment(self, src: ColumnRef, tgt: ColumnRef) -> ContainmentResult: ...

    def preview(self, src: ColumnRef, tgt: ColumnRef, limit: int) -> list[dict]: ...

    def multi_join_preview(
        self, steps: list[JoinStepRef], limit: int
    ) -> tuple[list[dict], str]: ...
