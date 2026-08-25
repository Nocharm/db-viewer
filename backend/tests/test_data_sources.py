"""data_sources 모델·시드 테스트. / DataSource model and seed row."""

from sqlalchemy.orm import sessionmaker

from app.models import DataSource
from app.models.sources import MANAGED_MSSQL_SOURCE_ID


def test_migration_seeds_managed_mssql_source(migrated_engine):
    # Arrange / Act
    with sessionmaker(bind=migrated_engine)() as db:
        source = db.get(DataSource, MANAGED_MSSQL_SOURCE_ID)

    # Assert: 기존 n8n MSSQL이 소스 1건으로 표현되고, UI가 못 건드리게 잠겨 있다
    assert source is not None
    assert source.engine == "mssql"
    assert source.access_mode == "n8n"
    assert source.is_managed is True
    assert source.is_enabled is True


def test_source_name_is_unique(migrated_engine):
    # Arrange
    from datetime import UTC, datetime

    import pytest
    from sqlalchemy.exc import IntegrityError

    now = datetime.now(UTC)
    with sessionmaker(bind=migrated_engine)() as db:
        db.add(DataSource(name="dup", engine="sqlite", access_mode="direct",
                          file_path="/tmp/a.db", is_enabled=True, is_managed=False,
                          created_at=now, updated_at=now))
        db.commit()

        # Act / Assert
        db.add(DataSource(name="dup", engine="sqlite", access_mode="direct",
                          file_path="/tmp/b.db", is_enabled=True, is_managed=False,
                          created_at=now, updated_at=now))
        with pytest.raises(IntegrityError):
            db.commit()


def _add_snapshot(db, source_id: int, status: str = "ready"):
    from datetime import UTC, datetime

    from app.models import Snapshot

    snap = Snapshot(collected_at=datetime.now(UTC), source_db="x",
                    status=status, data_source_id=source_id)
    db.add(snap)
    db.flush()
    return snap


def test_resolve_snapshot_picks_latest_ready_of_that_source(migrated_engine):
    # Arrange: 두 소스에 각각 ready 스냅샷
    from datetime import UTC, datetime

    from app.api.objects import resolve_snapshot
    from app.models import DataSource

    now = datetime.now(UTC)
    with sessionmaker(bind=migrated_engine)() as db:
        other = DataSource(name="svca", engine="postgres", access_mode="direct",
                           host="h", port=5432, database="d", username="u",
                           is_enabled=True, is_managed=False,
                           created_at=now, updated_at=now)
        db.add(other)
        db.flush()
        mssql_snap = _add_snapshot(db, MANAGED_MSSQL_SOURCE_ID)
        other_snap = _add_snapshot(db, other.id)
        db.commit()

        # Act / Assert: 소스를 지정하면 그 소스의 최신 ready
        assert resolve_snapshot(db, source_id=other.id).id == other_snap.id
        # 소스를 생략하면 기본 소스(사내 MSSQL) — 기존 호출자가 안 깨진다
        assert resolve_snapshot(db).id == mssql_snap.id
