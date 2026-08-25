"""External-IO adapters — validators, future AI clients. / 외부 IO 어댑터."""

from typing import TYPE_CHECKING

from app.config import Settings
from app.domain.validation import JoinValidator

if TYPE_CHECKING:
    from app.adapters.collect_runner import CollectRunner
    from app.models import DataSource


class SyntheticDataRefused(RuntimeError):
    """실 원천이 연결된 배포에서 합성 데이터 제공을 거부 / refuse synthetic data on a real deployment."""


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

    return FakeJoinValidator(settings.resolved_fixture_dir / "value_sets.json")


def create_table_preview(settings: Settings, source: "DataSource | None" = None):
    """테이블 미리보기 실행기 — live는 n8n W2, 순수 오프라인만 픽스처 합성 / preview executor.

    합성 행은 실값과 겉모습이 같아서(`EMP_CODE` → `EMPCOD001`) 실 카탈로그가 적재된
    화면에서는 검증을 오염시킨다. 실배포 판별은 수집 경로와 같은 신호인
    N8N_WEBHOOK_BASE로 한다 (create_collect_runner 주석 참조) — 원천이 붙어 있는데
    live가 아니면 합성 대신 명시 실패시켜 SOURCE_MODE 전환을 요구한다.

    direct 소스는 SOURCE_MODE와 무관하게 항상 실데이터다. n8n 소스만 기존 게이트를
    그대로 통과한다 (live 전환은 배포 절차가 지킨다, docs/connect.md).
    """
    if source is not None and source.access_mode == "direct":
        from app.sources.connection import get_sa_engine
        from app.sources.direct_preview import DirectTablePreview

        return DirectTablePreview(get_sa_engine(source))
    if settings.source_mode == "live":
        if not settings.n8n_webhook_base:
            raise RuntimeError("live mode requires N8N_WEBHOOK_BASE (W2 query executor)")
        from app.adapters.n8n_query import N8nTablePreview

        return N8nTablePreview(settings.n8n_webhook_base, settings.n8n_query_timeout)
    if settings.n8n_webhook_base:
        raise SyntheticDataRefused(
            "preview needs a real data source — a source is configured "
            f"(N8N_WEBHOOK_BASE) but SOURCE_MODE={settings.source_mode}; set "
            "SOURCE_MODE=live and restart the backend (docs/connect.md step 8). "
            "Synthetic rows are refused here because they are indistinguishable "
            "from real values."
        )
    from app.adapters.table_preview import FakeTablePreview

    return FakeTablePreview(settings.resolved_fixture_dir / "value_sets.json")


def create_collect_runner(settings: Settings, session_factory) -> "CollectRunner":
    """수집 러너 선택 — n8n이 연결돼 있으면 실수집, 아니면 픽스처 리플레이.

    수집 경로를 가르는 건 SOURCE_MODE가 아니라 N8N_WEBHOOK_BASE다. SOURCE_MODE는
    질의·검증의 데이터 원천(fixture/replay/live)을 정하는 값이고, 실카탈로그 수집은
    live 전환(정지점 18) *이전에* 해야 한다 — 런북 6단계는 `SOURCE_MODE=fixture` 상태로
    [1단계 카탈로그 수집]을 눌러 실 스키마를 적재한다 (docs/connect.md).
    Collection routes on the webhook base, not the query-source mode.
    """
    from app.adapters.collect_runner import FixtureCollectRunner, N8nCollectRunner

    if settings.n8n_webhook_base:
        return N8nCollectRunner(
            settings.n8n_webhook_base, session_factory,
            catalog_chunk_size=settings.collect_catalog_chunk_size,
            deps_chunk_size=settings.collect_deps_chunk_size,
            query_timeout=settings.n8n_query_timeout,
        )
    if settings.source_mode != "fixture":
        raise RuntimeError("N8N_WEBHOOK_BASE is required outside fixture mode")
    return FixtureCollectRunner(session_factory, settings.resolved_fixture_dir)
