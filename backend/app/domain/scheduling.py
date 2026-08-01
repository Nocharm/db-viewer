"""Night-window scheduling for T3 scans. / 야간 실행 창 계산 (계획 §4)."""

from datetime import datetime


def compute_not_before(
    now: datetime, night_only: bool, night_start_hour: int, night_end_hour: int
) -> datetime | None:
    """야간 전용 작업의 기동 가능 시각 — 이미 야간이면 즉시 / None means startable now."""
    if not night_only:
        return None
    if now.hour >= night_start_hour or now.hour < night_end_hour:
        return None  # 이미 야간 창 안 / already inside the window
    return now.replace(hour=night_start_hour, minute=0, second=0, microsecond=0)
