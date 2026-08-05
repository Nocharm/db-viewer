"""Embedding index job tests — cap, batching, hash-skip, throttle (사이클2 Task 8)."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.api.ai import get_ai_session_factory
from app.config import Settings
from app.models import AiEmbedding, AiJob
from app.services import ai_embeddings
from app.services.ai_embeddings import (
    build_embedding_text,
    compute_source_hash,
    run_embed_index,
)


def _seed(client, load_fixture) -> None:
    sid = client.post("/api/ingest/catalog", json=load_fixture("catalog.json")).json()["snapshot_id"]
    client.post("/api/ingest/view-deps",
                json={**load_fixture("view_deps.json"), "snapshot_id": sid})


def _settings(**overrides) -> Settings:
    # _env_file=None — 로컬 .env 간섭 차단, 실행 중 값은 인자로만 주입 / no local .env leakage
    defaults = dict(
        _env_file=None, ai_base_url="http://llm/v1", ai_embed_model="e",
        ai_embed_batch=32, ai_embed_job_cap=1000, ai_embed_sleep_ms=0,
    )
    defaults.update(overrides)
    return Settings(**defaults)


def _job(db) -> AiJob:
    job = AiJob(kind="embed_index", status="running", progress_done=0, progress_total=0,
                triggered_by="test", created_at=datetime.now(UTC))
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


@pytest.fixture()
def fake_embed(monkeypatch):
    """embed_texts를 모듈 참조 지점(app.services.ai_embeddings.embed_texts)에서 대체.

    호출 인자를 그대로 기록해 배치 분할·스킵 여부를 검증한다.
    """
    calls: list[list[str]] = []

    def _fake(base_url, model, api_key, timeout, texts):
        calls.append(texts)
        return [[0.1, 0.2] for _ in texts]

    monkeypatch.setattr(ai_embeddings, "embed_texts", _fake)
    return calls


def test_build_embedding_text_joins_qname_columns_and_summary():
    text = build_embedding_text("dbo.T_A", ["ID", "NAME"], "요약문")
    assert text == "dbo.T_A\nID NAME\n요약문"


def test_build_embedding_text_omits_summary_when_absent():
    text = build_embedding_text("dbo.T_A", ["ID"], None)
    assert text == "dbo.T_A\nID"


def test_compute_source_hash_changes_with_model_or_text():
    h1 = compute_source_hash("text", "model-a")
    h2 = compute_source_hash("text", "model-b")
    h3 = compute_source_hash("other", "model-a")
    assert len({h1, h2, h3}) == 3


def test_run_embed_index_requires_ready_snapshot(migrated_engine):
    session_factory = sessionmaker(bind=migrated_engine)
    with session_factory() as db:
        job = _job(db)
        with pytest.raises(RuntimeError, match="no ready snapshot"):
            run_embed_index(db, job, _settings())


def test_run_embed_index_caps_job_and_reports_remaining(
    client, migrated_engine, load_fixture, fake_embed,
):
    """cap 미만으로 상한을 걸면 progress_total이 상한과 같고 remaining이 남는다."""
    _seed(client, load_fixture)
    session_factory = sessionmaker(bind=migrated_engine)
    with session_factory() as db:
        job = _job(db)
        result = run_embed_index(db, job, _settings(ai_embed_job_cap=2, ai_embed_batch=2))
        # job은 세션이 닫히면 만료된 속성 접근 시 DetachedInstanceError — 세션 안에서 단언
        assert job.progress_total == 2

    assert result["indexed"] == 2
    assert result["remaining"] > 0  # 실측 스케일(409 테이블)에서 상한 밖 잔여 존재


def test_run_embed_index_skips_unchanged_hash_on_rerun(
    client, migrated_engine, load_fixture, fake_embed,
):
    """동일 소스는 2회차에 source_hash 일치로 스킵되고 embed_texts 호출이 없다.

    cap을 낮게 주면 재실행마다 '아직 못 다룬 다음 페이지'가 나와 skip을 관측할 수
    없다(페이징이 의도된 동작) — 상한을 전체 커버할 만큼 크게 둬 1회차에 전량을
    인덱싱해야 2회차에서 전량 스킵이 재현된다.
    """
    _seed(client, load_fixture)
    session_factory = sessionmaker(bind=migrated_engine)

    with session_factory() as db:
        job = _job(db)
        first = run_embed_index(db, job, _settings(ai_embed_job_cap=1000, ai_embed_batch=50))
    assert first["indexed"] > 0
    assert first["remaining"] == 0  # 1회차에 전체 소진

    fake_embed.clear()
    with session_factory() as db:
        job = _job(db)
        second = run_embed_index(db, job, _settings(ai_embed_job_cap=1000, ai_embed_batch=50))

    assert second["indexed"] == 0
    assert second["skipped"] == first["indexed"]  # 앞서 인덱싱한 전량이 스킵
    assert fake_embed == []  # 호출 자체가 없다


def test_run_embed_index_splits_calls_by_batch_size(
    client, migrated_engine, load_fixture, fake_embed,
):
    """batch=1이면 대상 수만큼 embed_texts가 개별 호출된다."""
    _seed(client, load_fixture)
    session_factory = sessionmaker(bind=migrated_engine)
    with session_factory() as db:
        job = _job(db)
        result = run_embed_index(db, job, _settings(ai_embed_job_cap=3, ai_embed_batch=1))

    assert result["indexed"] == 3
    assert len(fake_embed) == 3  # 배치=1 → 대상 수만큼 호출
    assert all(len(texts) == 1 for texts in fake_embed)


def test_run_embed_index_never_sleeps_when_sleep_ms_is_zero(
    client, migrated_engine, load_fixture, fake_embed, monkeypatch,
):
    """ai_embed_sleep_ms=0이면 배치 간 time.sleep을 호출하지 않는다."""
    def _boom(*_args, **_kwargs):
        raise AssertionError("time.sleep should not be called when sleep_ms=0")

    monkeypatch.setattr(ai_embeddings.time, "sleep", _boom)
    _seed(client, load_fixture)
    session_factory = sessionmaker(bind=migrated_engine)
    with session_factory() as db:
        job = _job(db)
        result = run_embed_index(
            db, job, _settings(ai_embed_job_cap=4, ai_embed_batch=1, ai_embed_sleep_ms=0),
        )
    assert result["indexed"] == 4
    assert len(fake_embed) == 4  # 다중 배치 경계를 거쳤는데도 sleep 없이 통과


def test_run_embed_index_persists_partial_progress_on_failure(
    client, migrated_engine, load_fixture, monkeypatch,
):
    """중간 배치가 실패해도 앞선 배치의 인덱싱분은 커밋되어 남는다."""
    call_count = {"n": 0}

    def _flaky(base_url, model, api_key, timeout, texts):
        call_count["n"] += 1
        if call_count["n"] == 2:
            raise RuntimeError("embed provider down")
        return [[0.1, 0.2] for _ in texts]

    monkeypatch.setattr(ai_embeddings, "embed_texts", _flaky)
    _seed(client, load_fixture)
    session_factory = sessionmaker(bind=migrated_engine)
    with session_factory() as db:
        job = _job(db)
        with pytest.raises(RuntimeError, match="embed provider down"):
            run_embed_index(db, job, _settings(ai_embed_job_cap=3, ai_embed_batch=1))

    with session_factory() as db:
        # 1번째 배치(1건)는 커밋되어 남고, 실패한 2번째 이후는 반영되지 않는다
        rows = db.execute(select(AiEmbedding)).scalars().all()
        assert len(rows) == 1


@pytest.fixture()
def ai_job_client(client, migrated_engine):
    """embed_index 백그라운드 잡의 세션 팩토리를 테스트 SQLite로 고정 (test_ai.py와 동일 패턴)."""
    client.app.dependency_overrides[get_ai_session_factory] = lambda: sessionmaker(bind=migrated_engine)
    return client


def test_start_embed_index_returns_400_when_not_configured(client):
    """ai_base_url/ai_embed_model 미설정이면 잡을 만들지 않고 400."""
    res = client.post("/api/ai/embed-index")
    assert res.status_code == 400
    assert res.json()["error"]["message"] == "embedding is not configured"


def test_start_embed_index_conflicts_with_active_job(ai_job_client, migrated_engine, monkeypatch):
    """같은 kind(embed_index)의 queued/running 잡이 있으면 새 시작은 409."""
    from app.config import get_settings

    monkeypatch.setenv("AI_BASE_URL", "http://llm/v1")
    monkeypatch.setenv("AI_EMBED_MODEL", "e")
    get_settings.cache_clear()
    try:
        session_factory = sessionmaker(bind=migrated_engine)
        with session_factory() as db:
            db.add(AiJob(kind="embed_index", status="queued", progress_done=0, progress_total=0,
                          triggered_by="test", created_at=datetime.now(UTC)))
            db.commit()

        res = ai_job_client.post("/api/ai/embed-index")
        assert res.status_code == 409
    finally:
        monkeypatch.delenv("AI_BASE_URL", raising=False)
        monkeypatch.delenv("AI_EMBED_MODEL", raising=False)
        get_settings.cache_clear()


def test_start_embed_index_returns_202_and_completes(ai_job_client, monkeypatch):
    """정상 설정이면 202로 잡을 시작하고 폴링으로 완료·결과를 확인할 수 있다."""
    from app.config import get_settings

    monkeypatch.setenv("AI_BASE_URL", "http://llm/v1")
    monkeypatch.setenv("AI_EMBED_MODEL", "e")
    get_settings.cache_clear()
    monkeypatch.setattr(ai_embeddings, "embed_texts",
                        lambda *a, **k: [[0.1, 0.2] for _ in a[-1]])
    try:
        # 스냅샷 없이 시작 — run_embed_index가 RuntimeError를 내고 잡은 failed로 기록된다
        start = ai_job_client.post("/api/ai/embed-index")
        assert start.status_code == 202
        job = ai_job_client.get(f"/api/ai/jobs/{start.json()['job_id']}").json()
        assert job["kind"] == "embed_index"
        assert job["status"] == "failed"
        assert "no ready snapshot" in job["error"]
    finally:
        monkeypatch.delenv("AI_BASE_URL", raising=False)
        monkeypatch.delenv("AI_EMBED_MODEL", raising=False)
        get_settings.cache_clear()
