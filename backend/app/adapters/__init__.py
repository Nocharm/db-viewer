"""External-IO adapters — validators, future AI clients. / 외부 IO 어댑터."""

from pathlib import Path

from app.config import Settings
from app.domain.validation import JoinValidator


def create_join_validator(settings: Settings) -> JoinValidator:
    """SOURCE_MODE에 따른 검증기 선택 / pick the validator for the configured mode.

    live는 보안 승인 게이트(계획 Phase 3) — 연결 단계(정지점 18) 전까지 차단.
    """
    if settings.source_mode == "live":
        raise RuntimeError(
            "live mode is blocked until security approval (connection step 18)"
        )
    from app.adapters.fake_validator import FakeJoinValidator

    return FakeJoinValidator(Path(settings.fixture_dir) / "value_sets.json")
