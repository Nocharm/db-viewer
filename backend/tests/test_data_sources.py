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
