"""Confidence pattern tests — 계획 §3.4 패턴 표 검증. / confidence pattern table tests."""

from datetime import UTC, datetime, timedelta

from app.domain.confidence import Observation, compute_confidence


def obs(containment: float, rows: int = 50_000, minutes: int = 0) -> Observation:
    return Observation(containment, rows, datetime(2026, 8, 1, tzinfo=UTC) + timedelta(minutes=minutes))


def test_no_observation():
    result = compute_confidence([])
    assert result.confidence is None and result.pattern == "no_observation"


def test_sustained_full_containment_is_effectively_fk():
    result = compute_confidence([obs(1.0, minutes=0), obs(1.0, minutes=1), obs(1.0, minutes=2)])
    assert result.pattern == "stable_confirmed"
    assert result.confidence == 1.0  # 3회 관측 + 대규모 → 만점


def test_orphan_band_is_valid_relation_with_quality_report():
    result = compute_confidence([obs(0.981, minutes=0), obs(0.978, minutes=1)])
    assert result.pattern == "stable_with_orphans"


def test_sudden_drop_raises_alert():
    result = compute_confidence([obs(1.0, minutes=0), obs(0.62, minutes=1)])
    assert result.pattern == "drop_alert"


def test_small_sample_full_containment_is_coincidence_candidate():
    result = compute_confidence([obs(1.0, rows=120)])
    assert result.pattern == "small_sample_only"
    assert result.confidence < 0.65  # 소량 + 단일 관측 패널티


def test_confidence_grows_with_observation_count():
    one = compute_confidence([obs(1.0)])
    three = compute_confidence([obs(1.0, minutes=0), obs(1.0, minutes=1), obs(1.0, minutes=2)])
    assert three.confidence > one.confidence


def test_unstable_history():
    result = compute_confidence([obs(0.6, minutes=0), obs(0.9, minutes=1)])
    assert result.pattern == "unstable"
