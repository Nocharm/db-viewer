"""External-IO adapters — validators, future AI clients. / 외부 IO 어댑터."""

from pathlib import Path
from typing import TYPE_CHECKING

from app.config import Settings
from app.domain.validation import JoinValidator

if TYPE_CHECKING:
    from app.adapters.collect_runner import CollectRunner


def create_join_validator(settings: Settings) -> JoinValidator:
    """SOURCE_MODE에 따른 검증기 선택 / pick the validator for the configured mode.

    live 전환은 보안 승인 후 운영자가 SOURCE_MODE=live로 명시할 때만 일어난다
    (정지점 18 게이트 — 코드가 아니라 배포 절차가 지킨다, docs/connect.md).
    실행 경로는 pyodbc 직결(계획 §4.3) 대신 n8n W2 경유 — 사용자 확정 편차.
    """
    if settings.source_mode == "live":
        if not settings.n8n_webhook_base:
            raise RuntimeError("live mode requires N8N_WEBHOOK_BASE (W2 query executor)")
        from app.adapters.n8n_query import N8nJoinValidator

        return N8nJoinValidator(settings.n8n_webhook_base, settings.n8n_query_timeout)
    from app.adapters.fake_validator import FakeJoinValidator

    return FakeJoinValidator(Path(settings.fixture_dir) / "value_sets.json")


def create_table_preview(settings: Settings):
    """테이블 미리보기 실행기 — live는 n8n W2, 그 외는 픽스처 합성 / preview executor."""
    if settings.source_mode == "live":
        if not settings.n8n_webhook_base:
            raise RuntimeError("live mode requires N8N_WEBHOOK_BASE (W2 query executor)")
        from app.adapters.n8n_query import N8nTablePreview

        return N8nTablePreview(settings.n8n_webhook_base, settings.n8n_query_timeout)
    from app.adapters.table_preview import FakeTablePreview

    return FakeTablePreview(Path(settings.fixture_dir) / "value_sets.json")


def create_collect_runner(settings: Settings, session_factory) -> "CollectRunner":
    """수집 러너 선택 — fixture는 리플레이, 그 외는 n8n webhook / pick the collect runner."""
    from app.adapters.collect_runner import FixtureCollectRunner, N8nWebhookRunner

    if settings.source_mode == "fixture":
        return FixtureCollectRunner(session_factory, settings.fixture_dir)
    if not settings.n8n_webhook_base:
        raise RuntimeError("N8N_WEBHOOK_BASE is required outside fixture mode")
    return N8nWebhookRunner(
        settings.n8n_webhook_base, session_factory,
        catalog_chunk_size=settings.collect_catalog_chunk_size,
        deps_chunk_size=settings.collect_deps_chunk_size,
        chunk_timeout=settings.collect_chunk_timeout,
    )
