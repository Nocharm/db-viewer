"""Button-triggered collection tests over the fixture runner. / 버튼 수집 픽스처 테스트."""

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker

from app.adapters.collect_runner import FixtureCollectRunner
from app.api.collect import get_collect_runner, get_collect_session_factory
from app.models import Base


@pytest.fixture()
def cclient(client, migrated_engine, fixture_dir):
    """수집 러너·세션 팩토리를 테스트 DB에 바인딩한 클라이언트 / client with bound runner."""
    session_factory = sessionmaker(bind=migrated_engine)
    client.app.dependency_overrides[get_collect_session_factory] = lambda: session_factory
    client.app.dependency_overrides[get_collect_runner] = lambda: FixtureCollectRunner(
        session_factory, str(fixture_dir)
    )
    return client


def _snapshot_status(engine, snapshot_id: int) -> str:
    snap_t = Base.metadata.tables["snapshots"]
    with engine.connect() as conn:
        return conn.execute(
            sa.select(snap_t.c.status).where(snap_t.c.id == snapshot_id)
        ).scalar_one()


def test_step_flow_catalog_then_view_deps(cclient, migrated_engine):
    # 1단계 — 202 접수 후 백그라운드에서 catalog_done까지 진행
    res = cclient.post("/api/collect/catalog", json={"triggered_by": "test"})
    assert res.status_code == 202
    job_id = res.json()["job_id"]

    job = cclient.get(f"/api/collect/jobs/{job_id}").json()
    assert job["stage"] == "catalog_done"
    assert job["snapshot_id"] is not None
    assert job["counts"]["objects"] > 0

    # 2단계 — 뷰 의존 + lineage·파싱 후 ready
    res = cclient.post("/api/collect/view-deps", json={"job_id": job_id})
    assert res.status_code == 202
    job = cclient.get(f"/api/collect/jobs/{job_id}").json()
    assert job["stage"] == "ready"
    assert job["counts"]["lineage_rows"] > 0
    assert _snapshot_status(migrated_engine, job["snapshot_id"]) == "ready"


def test_view_deps_gate_and_unknown_job(cclient):
    assert cclient.post("/api/collect/view-deps", json={"job_id": 999}).status_code == 404

    res = cclient.post("/api/collect/catalog", json={})
    job_id = res.json()["job_id"]
    cclient.post("/api/collect/view-deps", json={"job_id": job_id})
    # ready 상태에서 재실행 시도 → 409 (catalog_done 선행 조건)
    assert cclient.post("/api/collect/view-deps", json={"job_id": job_id}).status_code == 409


def test_full_flow_chains_to_ready(cclient, migrated_engine):
    res = cclient.post("/api/collect/full", json={"triggered_by": "test"})
    assert res.status_code == 202
    job = cclient.get(f"/api/collect/jobs/{res.json()['job_id']}").json()
    assert job["mode"] == "full"
    assert job["stage"] == "ready"
    assert _snapshot_status(migrated_engine, job["snapshot_id"]) == "ready"


def test_runner_failure_marks_job_failed(cclient):
    class BoomRunner:
        def run_catalog(self, job_id: int) -> None:
            raise RuntimeError("boom")

        def run_view_deps(self, job_id: int, snapshot_id: int) -> None:
            raise RuntimeError("boom")

    cclient.app.dependency_overrides[get_collect_runner] = lambda: BoomRunner()
    res = cclient.post("/api/collect/catalog", json={})
    job = cclient.get(f"/api/collect/jobs/{res.json()['job_id']}").json()
    assert job["stage"] == "failed"
    assert "boom" in job["error"]


def test_jobs_list_recent_first(cclient):
    first = cclient.post("/api/collect/catalog", json={}).json()["job_id"]
    second = cclient.post("/api/collect/catalog", json={}).json()["job_id"]
    items = cclient.get("/api/collect/jobs").json()["items"]
    assert [items[0]["job_id"], items[1]["job_id"]] == [second, first]


def test_n8n_runner_pages_catalog_windows(migrated_engine):
    """카탈로그도 객체 창 단위로 반복 호출 — 총 청크 수는 n8n이 알려준다."""
    import json as jsonlib
    from datetime import UTC, datetime

    from app.adapters.collect_runner import N8nWebhookRunner
    from app.models import CollectJob

    session_factory = sessionmaker(bind=migrated_engine)
    now = datetime.now(UTC)
    with session_factory() as db:
        job = CollectJob(mode="step", stage="catalog_running", triggered_by="test",
                         created_at=now, updated_at=now)
        db.add(job)
        db.commit()
        job_id = job.id

    calls: list[dict] = []
    runner = N8nWebhookRunner("http://n8n/webhook", session_factory,
                              catalog_chunk_size=300, chunk_timeout=5)
    chunk_total = 3

    def fake_post(path: str, body: dict) -> None:
        calls.append(body)
        index = len(calls)
        with session_factory() as db:
            j = db.get(CollectJob, job_id)
            j.counts = jsonlib.dumps({"catalog_chunks_done": index,
                                      "catalog_chunks_total": chunk_total})
            if index == chunk_total:  # 마지막 창에서 ingest가 단계 완료로 전환
                j.stage = "catalog_done"
            j.updated_at = datetime.now(UTC)
            db.commit()

    runner._post = fake_post
    runner.run_catalog(job_id)

    assert [c["offset"] for c in calls] == [0, 300, 600]
    assert all(c["limit"] == 300 and c["collect_job_id"] == job_id for c in calls)


def test_n8n_runner_single_catalog_chunk_stops_immediately(migrated_engine):
    """소규모 DB — 첫 콜백이 catalog_done이면 추가 호출 없음."""
    from datetime import UTC, datetime

    from app.adapters.collect_runner import N8nWebhookRunner
    from app.models import CollectJob

    session_factory = sessionmaker(bind=migrated_engine)
    now = datetime.now(UTC)
    with session_factory() as db:
        job = CollectJob(mode="step", stage="catalog_running", triggered_by="test",
                         created_at=now, updated_at=now)
        db.add(job)
        db.commit()
        job_id = job.id

    calls: list[dict] = []
    runner = N8nWebhookRunner("http://n8n/webhook", session_factory, chunk_timeout=5)

    def fake_post(path: str, body: dict) -> None:
        calls.append(body)
        with session_factory() as db:
            j = db.get(CollectJob, job_id)
            j.stage = "catalog_done"
            j.updated_at = datetime.now(UTC)
            db.commit()

    runner._post = fake_post
    runner.run_catalog(job_id)
    assert len(calls) == 1


def test_n8n_runner_pages_view_deps_and_waits_callbacks(migrated_engine):
    """뷰 N개 단위 분할 호출 — 청크 콜백 확인 후 다음 청크 진행 / paged webhook calls."""
    import json as jsonlib
    from datetime import UTC, datetime

    from app.adapters.collect_runner import N8nWebhookRunner
    from app.models import CatalogObject, CollectJob, Snapshot

    session_factory = sessionmaker(bind=migrated_engine)
    now = datetime.now(UTC)
    with session_factory() as db:
        snapshot = Snapshot(collected_at=now, source_db="T", status="collecting")
        db.add(snapshot)
        db.flush()
        for i in range(5):
            db.add(CatalogObject(snapshot_id=snapshot.id, schema="dbo",
                                 name=f"V_{i}", type="view", object_id=i + 1))
        job = CollectJob(mode="step", stage="deps_running", triggered_by="test",
                         created_at=now, updated_at=now, snapshot_id=snapshot.id)
        db.add(job)
        db.commit()
        snapshot_id, job_id = snapshot.id, job.id

    calls: list[dict] = []
    runner = N8nWebhookRunner("http://n8n/webhook", session_factory,
                              deps_chunk_size=2, chunk_timeout=5)

    def fake_post(path: str, body: dict) -> None:  # ingest 콜백까지 즉시 시뮬레이션
        calls.append(body)
        with session_factory() as db:
            j = db.get(CollectJob, job_id)
            j.counts = jsonlib.dumps({
                "deps_chunks_done": body["chunk_index"],
                "deps_chunks_total": body["chunk_total"],
            })
            if body["chunk_index"] == body["chunk_total"]:
                j.stage = "ready"
            j.updated_at = datetime.now(UTC)
            db.commit()

    runner._post = fake_post  # HTTP 경계만 목킹 / mock only the HTTP boundary
    runner.run_view_deps(job_id, snapshot_id)

    assert [c["offset"] for c in calls] == [0, 2, 4]  # ceil(5/2) = 3청크
    assert [c["chunk_index"] for c in calls] == [1, 2, 3]
    assert all(c["chunk_total"] == 3 and c["limit"] == 2 for c in calls)


def test_n8n_runner_raises_when_chunk_never_completes(migrated_engine):
    from datetime import UTC, datetime

    import pytest as _pytest

    from app.adapters import collect_runner as cr
    from app.models import CollectJob, Snapshot

    session_factory = sessionmaker(bind=migrated_engine)
    now = datetime.now(UTC)
    with session_factory() as db:
        snapshot = Snapshot(collected_at=now, source_db="T", status="collecting")
        db.add(snapshot)
        db.flush()
        job = CollectJob(mode="step", stage="deps_running", triggered_by="test",
                         created_at=now, updated_at=now, snapshot_id=snapshot.id)
        db.add(job)
        db.commit()
        snapshot_id, job_id = snapshot.id, job.id

    runner = cr.N8nWebhookRunner("http://n8n/webhook", session_factory,
                                 deps_chunk_size=10, chunk_timeout=0)  # 즉시 만료
    runner._post = lambda path, body: None  # 콜백이 오지 않는 상황
    with _pytest.raises(RuntimeError, match="did not complete"):
        runner.run_view_deps(job_id, snapshot_id)


def test_runner_selection_routes_on_webhook_base_not_source_mode(tmp_path):
    """런북 6단계 재현 — SOURCE_MODE=fixture + n8n 연결이면 실수집으로 가야 한다."""
    import pytest as _pytest

    from app.adapters import create_collect_runner
    from app.adapters.collect_runner import N8nWebhookRunner
    from app.config import Settings

    connected = Settings(source_mode="fixture", n8n_webhook_base="http://n8n/webhook")
    assert isinstance(create_collect_runner(connected, None), N8nWebhookRunner)

    offline = Settings(source_mode="fixture", n8n_webhook_base="", fixture_dir=str(tmp_path))
    assert isinstance(create_collect_runner(offline, None), FixtureCollectRunner)

    # n8n 없는 replay/live는 수집 경로가 없다 — 기존 게이트 유지
    with _pytest.raises(RuntimeError, match="N8N_WEBHOOK_BASE"):
        create_collect_runner(Settings(source_mode="live", n8n_webhook_base=""), None)


def test_fixture_runner_reports_missing_fixture_with_remedy(migrated_engine, tmp_path):
    """픽스처 없는 배포에서 ENOENT 대신 조치 가능한 메시지 / actionable, not ENOENT."""
    import pytest as _pytest

    session_factory = sessionmaker(bind=migrated_engine)
    runner = FixtureCollectRunner(session_factory, str(tmp_path / "missing"))
    with _pytest.raises(RuntimeError, match="N8N_WEBHOOK_BASE"):
        runner.run_catalog(1)


def test_cancel_unblocks_a_stuck_job(cclient):
    """멈춘 잡이 새 수집을 막지 않도록 실패로 닫는다 / cancel frees the UI gate."""
    from app.api.collect import get_collect_runner

    class HangingRunner:  # 트리거만 하고 콜백이 오지 않는 상황 (n8n 실행 유실)
        def run_catalog(self, job_id: int) -> None:
            pass

        def run_view_deps(self, job_id: int, snapshot_id: int) -> None:
            pass

    cclient.app.dependency_overrides[get_collect_runner] = lambda: HangingRunner()
    job_id = cclient.post("/api/collect/catalog", json={}).json()["job_id"]
    assert cclient.get(f"/api/collect/jobs/{job_id}").json()["stage"] == "catalog_running"

    res = cclient.post(f"/api/collect/jobs/{job_id}/cancel")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["stage"] == "failed" and "cancelled" in body["error"]

    # 이미 끝난 잡은 409 / cancelling a finished job is a conflict
    assert cclient.post(f"/api/collect/jobs/{job_id}/cancel").status_code == 409
    assert cclient.post("/api/collect/jobs/999/cancel").status_code == 404
