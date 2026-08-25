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


def _fake_query_runner(migrated_engine, rows_by_kind, chunk_size=2, deps_size=2):
    """W1 응답을 kind별로 대신 주는 러너 — HTTP 경계만 대체 / stubs only the HTTP boundary."""
    from app.adapters.collect_runner import N8nCollectRunner

    calls: list[dict] = []
    runner = N8nCollectRunner("http://n8n/webhook", sessionmaker(bind=migrated_engine),
                              catalog_chunk_size=chunk_size, deps_chunk_size=deps_size)

    def fake_query(kind: str, params: dict | None = None) -> list[dict]:
        calls.append({"kind": kind, **(params or {})})
        value = rows_by_kind.get(kind, [])
        return value(params or {}) if callable(value) else value

    runner._query = fake_query
    return runner, calls


def test_n8n_runner_drives_the_cascade_per_object_page(migrated_engine):
    """n8n은 단문 쿼리만 — 객체 페이지마다 그 페이지 id로 컬럼·키·뷰정의를 따로 부른다."""
    objects = [
        {"object_id": 10, "schema": "dbo", "name": "HR_EMP", "type": "table", "row_count": 5},
        {"object_id": 11, "schema": "dbo", "name": "HR_DEPT", "type": "table", "row_count": 2},
        {"object_id": 12, "schema": "dbo", "name": "V_EMP", "type": "view", "row_count": None},
    ]
    columns = {
        10: [{"object_id": 10, "name": "EMP_NO", "ordinal": 1, "data_type": "int",
              "max_length": 4, "is_nullable": False, "is_computed": False}],
        11: [{"object_id": 11, "name": "DEPT_CD", "ordinal": 1, "data_type": "varchar",
              "max_length": 10, "is_nullable": False, "is_computed": False}],
        12: [{"object_id": 12, "name": "EMP_NO", "ordinal": 1, "data_type": "int",
              "max_length": 4, "is_nullable": True, "is_computed": False}],
    }
    rows = {
        "totals": [{"object_total": 3, "view_total": 1}],
        "objects": lambda p: objects[p["offset"]: p["offset"] + p["limit"]],
        "columns": lambda p: [c for oid in p["object_ids"] for c in columns[oid]],
        "key_constraints": lambda p: (
            [{"name": "PK_HR_EMP", "type": "pk", "object_id": 10, "column_name": "EMP_NO"}]
            if 10 in p["object_ids"] else []),
        "foreign_keys": [],
        "view_definitions": lambda p: [{"object_id": oid, "definition": "SELECT 1"}
                                       for oid in p["object_ids"]],
    }
    runner, calls = _fake_query_runner(migrated_engine, rows, chunk_size=2)
    with sessionmaker(bind=migrated_engine)() as db:
        from datetime import UTC, datetime

        from app.models import CollectJob
        now = datetime.now(UTC)
        job = CollectJob(mode="step", stage="catalog_running", triggered_by="t",
                         created_at=now, updated_at=now)
        db.add(job)
        db.commit()
        job_id = job.id

    runner.run_catalog(job_id)

    # 페이지 1은 id 10·11로, 페이지 2는 id 12로 각각 별도 쿼리 (캐스케이드가 서비스에 있다)
    # 페이지1(테이블만)은 뷰 정의 쿼리를 아예 부르지 않는다 / no views on page 1 → no call
    assert [c["kind"] for c in calls] == [
        "totals",
        "objects", "columns", "key_constraints",
        "objects", "columns", "key_constraints", "foreign_keys", "view_definitions",
    ]
    assert [c["object_ids"] for c in calls if c["kind"] == "columns"] == [[10, 11], [12]]
    # 뷰 정의는 그 페이지의 뷰에만 / view defs only for views on that page
    assert [c["object_ids"] for c in calls if c["kind"] == "view_definitions"] == [[12]]

    import sqlalchemy as sa

    from app.models import Base
    with migrated_engine.connect() as conn:
        counted = {name: conn.execute(
            sa.select(sa.func.count()).select_from(Base.metadata.tables[name])).scalar()
            for name in ("objects", "columns")}
    assert counted == {"objects": 3, "columns": 3}
    with sessionmaker(bind=migrated_engine)() as db:
        from app.models import CollectJob
        assert db.get(CollectJob, job_id).stage == "catalog_done"


def test_n8n_runner_batches_view_deps_by_view_ids(migrated_engine):
    """뷰 의존도 배치 id 목록으로 — DMV 커서 크기를 서비스가 통제한다."""
    from datetime import UTC, datetime

    from app.models import CatalogObject, CollectJob, Snapshot
    from app.models.sources import MANAGED_MSSQL_SOURCE_ID

    factory = sessionmaker(bind=migrated_engine)
    now = datetime.now(UTC)
    with factory() as db:
        snap = Snapshot(collected_at=now, source_db="T", status="collecting",
                        data_source_id=MANAGED_MSSQL_SOURCE_ID)
        db.add(snap)
        db.flush()
        for oid in (21, 22, 23):
            db.add(CatalogObject(snapshot_id=snap.id, schema="dbo", name=f"V{oid}",
                                 type="view", object_id=oid))
        job = CollectJob(mode="step", stage="deps_running", triggered_by="t",
                         created_at=now, updated_at=now, snapshot_id=snap.id)
        db.add(job)
        db.commit()
        snapshot_id, job_id = snap.id, job.id

    runner, calls = _fake_query_runner(
        migrated_engine, {"view_refs": [], "view_deps": []}, deps_size=2)
    runner.run_view_deps(job_id, snapshot_id)

    assert [c["object_ids"] for c in calls if c["kind"] == "view_refs"] == [[21, 22], [23]]
    assert [c["kind"] for c in calls] == [
        "view_refs", "view_deps", "view_refs", "view_deps"]


def test_n8n_runner_raises_after_query_retries(migrated_engine, monkeypatch):
    from urllib.error import URLError

    import pytest as _pytest

    from app.adapters import collect_runner as cr

    attempts = []

    def failing_urlopen(request, timeout=None):
        attempts.append(1)
        raise URLError("connection refused")

    # 모듈 리로드는 다른 테스트의 클래스 동일성을 깨뜨린다 — monkeypatch로 국한
    monkeypatch.setattr(cr.urllib.request, "urlopen", failing_urlopen)
    runner = cr.N8nCollectRunner("http://n8n/webhook", sessionmaker(bind=migrated_engine))
    with _pytest.raises(RuntimeError, match="catalog query failed"):
        runner._query("totals")
    assert len(attempts) == 2  # 1회 재시도 후 마지막 오류 / one retry then raise


def test_runner_selection_routes_on_webhook_base_not_source_mode(tmp_path):
    """런북 6단계 재현 — SOURCE_MODE=fixture + n8n 연결이면 실수집으로 가야 한다."""
    import pytest as _pytest

    from app.adapters import create_collect_runner
    from app.adapters.collect_runner import N8nCollectRunner
    from app.config import Settings

    connected = Settings(source_mode="fixture", n8n_webhook_base="http://n8n/webhook")
    assert isinstance(create_collect_runner(connected, None), N8nCollectRunner)

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


def test_group_constraints_keeps_same_named_constraints_apart():
    """제약 이름은 스키마 단위로만 유일 — 동명 제약이 한 덩어리로 합쳐지면 안 된다.

    실서버 FK 적재 실패(FK_agent_subscript / 'unknown column')의 근본 원인 회귀 가드.
    """
    from app.adapters.collect_runner import _group_foreign_keys, _group_key_constraints

    # 서로 다른 스키마의 동명 FK — 참조 대상 테이블이 다르다
    fks = _group_foreign_keys([
        {"name": "FK_agent_sub", "src_object_id": 10, "tgt_object_id": 20,
         "src_column": "subscriptionid", "tgt_column": "id"},
        {"name": "FK_agent_sub", "src_object_id": 30, "tgt_object_id": 40,
         "src_column": "sub_no", "tgt_column": "sub_id"},
    ])
    assert len(fks) == 2, "동명 FK가 병합되면 남의 테이블 컬럼을 참조하게 된다"
    assert {(f["src_object_id"], f["columns"][0]["src_column"]) for f in fks} == {
        (10, "subscriptionid"), (30, "sub_no")}
    assert all(len(f["columns"]) == 1 for f in fks)

    # 같은 FK의 복합 컬럼은 여전히 하나로 묶인다 / composite keys still group
    composite = _group_foreign_keys([
        {"name": "FK_c", "src_object_id": 1, "tgt_object_id": 2,
         "src_column": "a", "tgt_column": "x"},
        {"name": "FK_c", "src_object_id": 1, "tgt_object_id": 2,
         "src_column": "b", "tgt_column": "y"},
    ])
    assert len(composite) == 1 and len(composite[0]["columns"]) == 2

    # PK/UQ도 동일 — 병합되면 엉뚱한 컬럼에 PK 플래그가 선다
    kcs = _group_key_constraints([
        {"name": "PK_common", "type": "pk", "object_id": 10, "column_name": "id"},
        {"name": "PK_common", "type": "pk", "object_id": 30, "column_name": "code"},
    ])
    assert len(kcs) == 2
    assert {(k["object_id"], tuple(k["columns"])) for k in kcs} == {
        (10, ("id",)), (30, ("code",))}


def test_ingest_skips_unresolvable_fk_instead_of_failing(client, migrated_engine, load_fixture):
    """FK 하나가 스냅샷 밖을 가리켜도 수집 전체를 버리지 않고 건수로 드러낸다."""
    payload = load_fixture("catalog.json")
    payload["foreign_keys"] = payload["foreign_keys"] + [{
        "name": "FK_dangling", "src_object_id": 999_001, "tgt_object_id": 999_002,
        "columns": [{"src_column": "nope", "tgt_column": "missing"}],
    }]
    res = client.post("/api/ingest/catalog", json=payload)
    assert res.status_code == 200, res.text
    counts = res.json()["counts"]
    assert counts["foreign_keys_skipped"] == 1
    # 정상 FK는 그대로 적재 / the healthy FKs still land
    assert counts["foreign_keys"] == len(payload["foreign_keys"]) - 1


@pytest.fixture()
def direct_sqlite_source_id(migrated_engine, tmp_path):
    """direct 소스로 쓸 실 SQLite 파일 + 등록 행 — source_id 라우팅 테스트용.

    소스 id는 자동증가라 테스트마다 값이 겹친다(사내 MSSQL이 id=1을 차지해 항상 2부터
    시작) — 엔진 캐시(app.sources.connection)는 프로세스 전역이라 이전 테스트가 같은 id로
    남긴 캐시를 걷어내고, 다음 테스트를 위해 끝나고도 비운다(test_direct_preview.py와 동일 관용).
    """
    import sqlite3
    from datetime import UTC, datetime

    from app.models import DataSource
    from app.sources.connection import clear_sa_engine

    path = tmp_path / "direct-src.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)")
    conn.commit()
    conn.close()
    now = datetime.now(UTC)
    with sessionmaker(bind=migrated_engine)() as db:
        source = DataSource(name="direct-src", engine="sqlite", access_mode="direct",
                            file_path=str(path), is_enabled=True, is_managed=False,
                            created_at=now, updated_at=now)
        db.add(source)
        db.commit()
        source_id = source.id
    clear_sa_engine(source_id)
    yield source_id
    clear_sa_engine(source_id)


def test_catalog_trigger_routes_source_id_to_direct_runner(
    cclient, migrated_engine, direct_sqlite_source_id,
):
    """source_id가 direct 소스를 가리키면 API 트리거가 DirectCollectRunner로 라우팅된다 —
    cclient가 오버라이드한 FixtureCollectRunner(기본 러너)는 이 요청에 쓰이지 않는다."""
    # Arrange
    source_id = direct_sqlite_source_id

    # Act
    res = cclient.post("/api/collect/catalog",
                       json={"triggered_by": "test", "source_id": source_id})
    assert res.status_code == 202
    job_id = res.json()["job_id"]

    # Assert: direct 소스는 뷰 의존 단계 없이 run_catalog 하나로 곧장 ready 마감된다
    job = cclient.get(f"/api/collect/jobs/{job_id}").json()
    assert job["stage"] == "ready"
    assert _snapshot_status(migrated_engine, job["snapshot_id"]) == "ready"


def test_full_trigger_direct_source_does_not_hang_on_view_deps_wait(
    cclient, migrated_engine, direct_sqlite_source_id, monkeypatch,
):
    """direct 소스는 run_catalog가 곧장 'ready'로 마감하고 'catalog_done'을 거치지 않는다 —
    full 체인이 그 값을 기다리다 타임아웃 뒤 오탐으로 failed를 덮어쓰면 안 된다(회귀 가드).
    타임아웃 상수를 줄여, 게이트가 없으면 이 테스트가 15분 대기 대신 즉시 실패하게 한다.
    """
    from app.api import collect as collect_module

    monkeypatch.setattr(collect_module, "CHAIN_TIMEOUT", 1)
    monkeypatch.setattr(collect_module, "CHAIN_POLL_INTERVAL", 0.05)
    # Arrange
    source_id = direct_sqlite_source_id

    # Act
    res = cclient.post("/api/collect/full",
                       json={"triggered_by": "test", "source_id": source_id})
    assert res.status_code == 202
    job_id = res.json()["job_id"]

    # Assert
    job = cclient.get(f"/api/collect/jobs/{job_id}").json()
    assert job["stage"] == "ready"
    assert _snapshot_status(migrated_engine, job["snapshot_id"]) == "ready"


def test_view_deps_trigger_is_a_noop_for_a_finished_direct_source_job(
    cclient, direct_sqlite_source_id,
):
    """direct 소스 잡은 catalog_done을 거치지 않고 곧장 ready로 끝난다 — 그런 잡에 2단계
    엔드포인트를 다시 불러도 "카탈로그가 안 끝났다"는 거짓 409를 주면 안 된다(멱등 no-op)."""
    # Arrange: direct 소스로 카탈로그를 완료한 잡(사전조건: 곧장 ready)
    res = cclient.post("/api/collect/catalog",
                       json={"triggered_by": "test", "source_id": direct_sqlite_source_id})
    job_id = res.json()["job_id"]
    assert cclient.get(f"/api/collect/jobs/{job_id}").json()["stage"] == "ready"

    # Act
    res = cclient.post("/api/collect/view-deps", json={"job_id": job_id})

    # Assert: 409가 아니라 이미 끝난 상태를 그대로 돌려준다
    assert res.status_code != 409, res.text
    assert res.json()["stage"] == "ready"


def test_view_deps_trigger_still_409s_for_unfinished_non_direct_job(cclient, migrated_engine):
    """n8n/픽스처 소스는 기존 동작 그대로 — 진짜로 카탈로그가 안 끝났으면 여전히 409다.
    direct 소스만을 위한 no-op 분기가 non-direct(사내 MSSQL) 잡까지 새 나가면 안 된다."""
    # Arrange: 카탈로그 진행 중인 잡 (사내 MSSQL 소스 = non-direct)
    from datetime import UTC, datetime

    from app.models import CollectJob

    now = datetime.now(UTC)
    with sessionmaker(bind=migrated_engine)() as db:
        job = CollectJob(mode="step", stage="catalog_running", triggered_by="test",
                         created_at=now, updated_at=now)
        db.add(job)
        db.commit()
        job_id = job.id

    # Act
    res = cclient.post("/api/collect/view-deps", json={"job_id": job_id})

    # Assert
    assert res.status_code == 409
