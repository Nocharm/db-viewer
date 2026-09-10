"""값 추적 테이블 — 마이그레이션·캐스케이드·설정 기본값. / value-probe tables and settings."""

import json
from datetime import UTC, datetime

import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker

from app.config import get_settings
from app.models import ValueProbeHit, ValueProbeJob, ValueProbeTarget


def test_migration_creates_the_three_tables(migrated_engine):
    names = set(sa.inspect(migrated_engine).get_table_names())
    assert {"value_probe_jobs", "value_probe_targets", "value_probe_hits"} <= names


def _seed(db) -> int:
    now = datetime.now(UTC)
    job = ValueProbeJob(data_source_id=1, snapshot_id=1, value="ORD-1", mode="normalized",
                        hint=None, schemas=json.dumps(["SAP"]), status="queued",
                        progress_total=1, progress_done=0, cancel_requested=False,
                        triggered_by="test", created_at=now)
    db.add(job)
    db.flush()
    target = ValueProbeTarget(job_id=job.id, object_id=10, qname="SAP.T_ORD", object_type="table",
                              columns=json.dumps([{"name": "ORD_NO"}]), tier="auto",
                              heavy_reason=None, rank=1, est_rows=100, status="pending")
    db.add(target)
    db.flush()
    db.add(ValueProbeHit(job_id=job.id, target_id=target.id, object_id=10, object_type="table",
                         qname="SAP.T_ORD", column_name="ORD_NO", match_count=1,
                         count_capped=False, matched_variant="ORD-1"))
    db.commit()
    return job.id


def test_deleting_a_job_cascades_to_targets_and_hits(migrated_engine):
    # Arrange
    factory = sessionmaker(bind=migrated_engine)
    with factory() as db:
        db.execute(sa.text("PRAGMA foreign_keys=ON"))
        job_id = _seed(db)
        # Act
        db.delete(db.get(ValueProbeJob, job_id))
        db.commit()
        # Assert
        assert db.execute(sa.select(sa.func.count()).select_from(ValueProbeTarget)).scalar_one() == 0
        assert db.execute(sa.select(sa.func.count()).select_from(ValueProbeHit)).scalar_one() == 0


def test_status_check_constraint_rejects_unknown_values(migrated_engine):
    factory = sessionmaker(bind=migrated_engine)
    with factory() as db:
        job_id = _seed(db)
        db.get(ValueProbeJob, job_id).status = "bogus"
        try:
            db.commit()
        except sa.exc.IntegrityError:
            db.rollback()
        else:
            raise AssertionError("CHECK constraint on status did not fire")


def test_value_probe_settings_defaults():
    settings = get_settings()
    assert settings.value_probe_heavy_rows == 2_000_000
    assert settings.value_probe_max_concurrent == 1
    assert settings.value_probe_contains_max_tables == 20
