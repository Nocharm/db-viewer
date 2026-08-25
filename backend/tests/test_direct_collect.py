"""직결 수집 왕복 — SQLite 파일 → 스냅샷. / direct collection: file to snapshot."""

import sqlite3
from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.models import CatalogObject, CollectJob, DataSource, Snapshot
from app.sources.connection import clear_sa_engine
from app.sources.direct_runner import DirectCollectRunner


@pytest.fixture()
def sqlite_source_row(tmp_path, migrated_engine):
    # Arrange: 실 SQLite 파일 + 등록된 소스 행
    path = tmp_path / "app.db"
    conn = sqlite3.connect(path)
    conn.executescript(
        "CREATE TABLE parent (id INTEGER PRIMARY KEY);"
        "CREATE TABLE child (id INTEGER PRIMARY KEY,"
        " parent_id INTEGER REFERENCES parent(id));"
    )
    conn.commit()
    conn.close()
    now = datetime.now(UTC)
    factory = sessionmaker(bind=migrated_engine)
    with factory() as db:
        source = DataSource(name="svcc", engine="sqlite", access_mode="direct",
                            file_path=str(path), is_enabled=True, is_managed=False,
                            created_at=now, updated_at=now)
        db.add(source)
        job = CollectJob(mode="step", stage="catalog_running", triggered_by="test",
                         created_at=now, updated_at=now)
        db.add(job)
        db.commit()
        source_id, job_id = source.id, job.id
    # 소스 id는 자동증가라 테스트마다 값이 겹친다(매 테스트가 새 임시 DB를 쓰므로 항상 2부터
    # 시작) — 엔진 캐시(app.sources.connection)는 프로세스 전역이라 이전 테스트가 같은 id로
    # 남긴 캐시를 걷어내고, 다음 테스트를 위해 끝나고도 비운다(test_direct_preview.py와 동일 관용)
    clear_sa_engine(source_id)
    yield factory, source_id, job_id
    clear_sa_engine(source_id)


def test_direct_collection_creates_a_ready_snapshot(sqlite_source_row):
    # Arrange
    factory, source_id, job_id = sqlite_source_row
    with factory() as db:
        source = db.get(DataSource, source_id)
        runner = DirectCollectRunner(source, factory)

    # Act
    runner.run_catalog(job_id)

    # Assert: 스냅샷이 그 소스에 매달리고 객체가 적재되며, 그 자리에서 조회 가능해진다
    # (뷰 의존 단계가 없는 direct 소스는 run_catalog가 스스로 ready로 마감해야 한다 — 아니면
    # resolve_snapshot이 찾는 status=='ready'가 영영 안 와서 화면에 나타나지 않는다)
    with factory() as db:
        snapshot = db.execute(
            select(Snapshot).where(Snapshot.data_source_id == source_id)
        ).scalar_one()
        names = set(db.execute(
            select(CatalogObject.name)
            .where(CatalogObject.snapshot_id == snapshot.id)).scalars())
    assert names == {"parent", "child"}
    assert snapshot.status == "ready"
    with factory() as db:
        assert db.get(CollectJob, job_id).stage == "ready"


def test_view_deps_step_is_a_noop_for_direct_sources(sqlite_source_row):
    # Arrange: 비-MSSQL은 lineage를 만들지 않는다 (T-SQL 파서 대상이 아니다)
    factory, source_id, job_id = sqlite_source_row
    with factory() as db:
        runner = DirectCollectRunner(db.get(DataSource, source_id), factory)
    runner.run_catalog(job_id)

    with factory() as db:
        snapshot_id = db.execute(
            select(Snapshot.id).where(Snapshot.data_source_id == source_id)
        ).scalar_one()

    # Act
    runner.run_view_deps(job_id, snapshot_id)

    # Assert: 이미 완료된 상태가 깨지지 않는다 (전체 모드 체인이 이 단계를 불러도 안전해야 한다).
    # CollectJob.stage 체크 제약은 'ready'까지만 허용한다 — 'done'은 존재하지 않는 값이다.
    with factory() as db:
        assert db.get(CollectJob, job_id).stage == "ready"
        assert db.get(Snapshot, snapshot_id).status == "ready"


def test_view_deps_ingest_skips_phase2_for_non_mssql_source(client, migrated_engine):
    """Phase 2는 T-SQL 파서 기반 — mssql이 아닌 소스의 뷰는 파싱하지 않고 parse_status를
    NULL로 남긴다. counts에 phase2 전용 키가 없다는 것으로 '건너뜀'을 직접 확인한다
    (단순히 예외가 안 나는 것과는 다르다)."""
    # Arrange: postgres 소스 + 뷰 정의 하나를 포함한 카탈로그
    now = datetime.now(UTC)
    factory = sessionmaker(bind=migrated_engine)
    with factory() as db:
        source = DataSource(name="pgsrc", engine="postgres", access_mode="direct",
                            host="db", port=5432, database="d", username="u",
                            is_enabled=True, is_managed=False,
                            created_at=now, updated_at=now)
        db.add(source)
        db.commit()
        source_id = source.id

    payload = {
        "source_db": "pg", "data_source_id": source_id,
        "collected_at": now.isoformat(),
        "objects": [{"object_id": 1, "schema": "public", "name": "v1", "type": "view",
                     "row_count": None}],
        "columns": [{"object_id": 1, "name": "id", "ordinal": 1, "data_type": "int4",
                     "max_length": 4, "is_nullable": False, "is_computed": False}],
        "view_definitions": [{"object_id": 1, "definition": "SELECT 1 AS id"}],
    }
    res = client.post("/api/ingest/catalog", json=payload)
    assert res.status_code == 200, res.text
    snapshot_id = res.json()["snapshot_id"]

    # Act
    res = client.post("/api/ingest/view-deps", json={"snapshot_id": snapshot_id, "deps": []})

    # Assert
    assert res.status_code == 200, res.text
    counts = res.json()["counts"]
    assert "views_parsed" not in counts
    assert "column_lineage_rows" not in counts
    with factory() as db:
        obj = db.execute(
            select(CatalogObject).where(CatalogObject.snapshot_id == snapshot_id)
        ).scalar_one()
        assert obj.parse_status is None


def test_run_view_deps_does_not_revive_a_failed_job(sqlite_source_row):
    """run_view_deps는 무조건 ready로 덮어쓰지 않는다 — 실패한 잡을 성공으로 뒤집으면
    안 된다(실패 원인 격리 규칙, rules/common/error-handling.md)."""
    # Arrange: 실패로 끝난 잡 (run_catalog를 거치지 않아 스냅샷이 없다 — 실패 시 흔한 상태)
    factory, source_id, job_id = sqlite_source_row
    with factory() as db:
        job = db.get(CollectJob, job_id)
        job.stage = "failed"
        job.error = "boom"
        db.commit()
        runner = DirectCollectRunner(db.get(DataSource, source_id), factory)

    # Act
    runner.run_view_deps(job_id, snapshot_id=999)

    # Assert: failed·에러 메시지 그대로 — ready로 뒤집히지 않는다
    with factory() as db:
        job = db.get(CollectJob, job_id)
        assert job.stage == "failed"
        assert job.error == "boom"
