"""T3 exploratory scan tests. / 탐색 스캔 테스트 (계획 Phase 4)."""

from datetime import UTC, datetime

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker

from app.adapters.fake_validator import FakeJoinValidator
from app.api.scan import get_scan_session_factory
from app.api.validate import get_join_validator
from app.domain.scheduling import compute_not_before
from app.models import Base


def test_night_window_calculation():
    day = datetime(2026, 8, 1, 14, 30, tzinfo=UTC)
    night = datetime(2026, 8, 1, 22, 0, tzinfo=UTC)
    dawn = datetime(2026, 8, 1, 3, 0, tzinfo=UTC)

    assert compute_not_before(day, False, 20, 6) is None
    assert compute_not_before(night, True, 20, 6) is None  # 이미 야간 / already night
    assert compute_not_before(dawn, True, 20, 6) is None
    deferred = compute_not_before(day, True, 20, 6)
    assert deferred is not None and deferred.hour == 20


@pytest.fixture()
def sclient(client, fixture_dir, migrated_engine):
    """검증기 + 백그라운드 세션 팩토리 오버라이드 / validator and task-session overrides."""
    client.app.dependency_overrides[get_join_validator] = lambda: FakeJoinValidator(
        fixture_dir / "value_sets.json"
    )
    factory = sessionmaker(bind=migrated_engine)
    client.app.dependency_overrides[get_scan_session_factory] = lambda: factory
    return client


def _seed(client, load_fixture) -> None:
    sid = client.post("/api/ingest/catalog", json=load_fixture("catalog.json")).json()["snapshot_id"]
    client.post("/api/ingest/view-deps",
                json={**load_fixture("view_deps.json"), "snapshot_id": sid})


def _column_id(engine, object_qname: str, column: str) -> int:
    schema, table = object_qname.split(".", 1)
    obj_t, col_t = Base.metadata.tables["objects"], Base.metadata.tables["columns"]
    with engine.connect() as conn:
        return conn.execute(
            sa.select(col_t.c.id)
            .join(obj_t, col_t.c.object_id == obj_t.c.id)
            .where(obj_t.c.schema == schema, obj_t.c.name == table, col_t.c.name == column)
        ).scalar_one()


def test_scan_finds_expected_relation(sclient, migrated_engine, load_fixture):
    """탐색 스캔이 실제 관계를 상위 결과로 찾아야 한다 / scan surfaces the true parent."""
    _seed(sclient, load_fixture)
    rel = next(r for r in load_fixture("expected/relations.json")["rows"]
               if r["kind"] == "real_no_fk" and r["orphan_count"] == 0)
    src_id = _column_id(migrated_engine, rel["src_object"], rel["src_column"])

    res = sclient.post("/api/scan", json={"column_id": src_id, "triggered_by": "test"})
    assert res.status_code == 202
    job_id = res.json()["job_id"]

    # TestClient는 백그라운드 태스크를 응답 후 동기 실행한다 / tasks run before poll
    body = sclient.get(f"/api/jobs/{job_id}").json()
    assert body["status"] == "done", body
    assert body["progress"]["done"] == body["progress"]["total"] > 0

    hits = {(r["tgt_object"], r["tgt_column"]): r for r in body["results"]}
    hit = hits.get((rel["tgt_object"], rel["tgt_column"]))
    assert hit is not None, body["results"]
    assert hit["containment_full"] == 1.0
    # 샘플 값과 풀 재검증 값이 별도 기록 / sample and full values recorded separately
    assert hit["containment_sample"] is not None

    with migrated_engine.connect() as conn:
        relations = conn.execute(sa.select(Base.metadata.tables["relations"])).all()
    assert any(
        r.tgt_object == rel["tgt_object"] and r.tgt_column == rel["tgt_column"]
        and r.status == "validated"
        for r in relations
    )


def test_night_only_scan_stays_queued_during_day(sclient, migrated_engine, load_fixture):
    _seed(sclient, load_fixture)
    rel = load_fixture("expected/relations.json")["rows"][0]
    src_id = _column_id(migrated_engine, rel["src_object"], rel["src_column"])

    from app.config import get_settings
    now = datetime.now(UTC)
    if now.hour >= get_settings().scan_night_start_hour or now.hour < get_settings().scan_night_end_hour:
        pytest.skip("실행 시각이 야간 창 안 — 주간 시나리오만 검증")

    res = sclient.post("/api/scan", json={"column_id": src_id, "night_only": True})
    assert res.status_code == 202
    assert res.json()["not_before"] is not None
    body = sclient.get(f"/api/jobs/{res.json()['job_id']}").json()
    assert body["status"] == "queued"  # 야간 전 기동 금지 / must not start before the window


def test_scan_on_trap_column_is_rejected(sclient, migrated_engine, load_fixture):
    _seed(sclient, load_fixture)
    trap = load_fixture("manifest.json")["cases"]["low_cardinality"][0]
    obj, col = trap.rsplit(".", 1)
    src_id = _column_id(migrated_engine, obj, col)
    res = sclient.post("/api/scan", json={"column_id": src_id})
    assert res.status_code == 400
    assert res.json()["error"]["context"]["reason"] in ("blacklist", "low_distinct")


def test_unknown_job_is_404(sclient):
    assert sclient.get("/api/jobs/999").status_code == 404
