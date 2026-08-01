"""External-IO adapters — validators, future AI clients. / 외부 IO 어댑터."""

from pathlib import Path
from typing import TYPE_CHECKING

from app.config import Settings
from app.domain.validation import JoinValidator

if TYPE_CHECKING:
    from app.adapters.collect_runner import CollectRunner


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


def create_collect_runner(settings: Settings, session_factory) -> "CollectRunner":
    """수집 러너 선택 — fixture는 리플레이, 그 외는 n8n webhook / pick the collect runner."""
    from app.adapters.collect_runner import FixtureCollectRunner, N8nWebhookRunner

    if settings.source_mode == "fixture":
        return FixtureCollectRunner(session_factory, settings.fixture_dir)
    if not settings.n8n_webhook_base:
        raise RuntimeError("N8N_WEBHOOK_BASE is required outside fixture mode")
    return N8nWebhookRunner(settings.n8n_webhook_base)
