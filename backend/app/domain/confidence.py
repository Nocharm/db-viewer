"""Confidence from observation history — 관측 횟수·지속성·데이터 규모 종합 (계획 §3.4)."""

from dataclasses import dataclass
from datetime import datetime

# 튜닝 상수 — 판정 대역 / tuning bands for the plan's pattern table
STABLE_THRESHOLD = 0.995  # "지속 1.0" 하한 / floor for "effectively an FK"
ORPHAN_BAND = 0.95        # 고아 데이터 대역 하한 / floor for "valid with orphans"
DROP_DELTA = 0.10         # 급락 판정 폭 / drop size that triggers an alert
SMALL_ROWS = 1_000        # 이하면 소량 데이터 — 1.0이어도 우연 가능 / small-sample cutoff
SCALE_ROWS = 5_000        # 규모 가중이 1.0이 되는 행수 / rows for full scale weight


@dataclass(frozen=True)
class Observation:
    containment: float
    src_row_count: int
    observed_at: datetime


@dataclass(frozen=True)
class ConfidenceResult:
    confidence: float | None
    # stable_confirmed: 사실상 확정 FK / stable_with_orphans: 유효 + 품질 리포트
    # drop_alert: 스키마·데이터 변경 의심 / small_sample_only: 소량 데이터 — 우연 가능
    pattern: str
    observation_count: int


def compute_confidence(observations: list[Observation]) -> ConfidenceResult:
    """단일 관측이 아니라 이력 전체로 계산 (계획 §3.4). / whole-history confidence."""
    if not observations:
        return ConfidenceResult(None, "no_observation", 0)

    ordered = sorted(observations, key=lambda o: o.observed_at)
    last = ordered[-1]
    count = len(ordered)
    max_rows = max(o.src_row_count for o in ordered)

    if (
        count >= 2
        and ordered[-2].containment >= STABLE_THRESHOLD
        and ordered[-2].containment - last.containment >= DROP_DELTA
    ):
        pattern = "drop_alert"  # 1.0 → 급락: 변경 사고 신호 / sudden drop
    elif all(o.containment >= STABLE_THRESHOLD for o in ordered):
        pattern = "small_sample_only" if max_rows < SMALL_ROWS else "stable_confirmed"
    elif all(o.containment >= ORPHAN_BAND for o in ordered):
        pattern = "stable_with_orphans"
    else:
        pattern = "unstable"

    count_weight = min(1.0, 0.6 + 0.2 * (count - 1))       # 1회 0.6 → 3회 1.0
    scale_weight = 0.5 + 0.5 * min(1.0, max_rows / SCALE_ROWS)
    confidence = round(last.containment * count_weight * scale_weight, 4)
    return ConfidenceResult(confidence, pattern, count)
