"""미리보기 허용이 소스 경계를 넘지 않는지. / allowlist must not leak across sources."""

from datetime import UTC, datetime

from sqlalchemy.orm import sessionmaker

from app.models import DataSource, PreviewAllowlist
from app.models.sources import MANAGED_MSSQL_SOURCE_ID
from app.services.preview_policy import is_preview_allowed


def test_allowlist_does_not_leak_across_sources(migrated_engine):
    # Arrange: 소스 A에서만 'public'을 허용
    now = datetime.now(UTC)
    with sessionmaker(bind=migrated_engine)() as db:
        other = DataSource(name="svcb", engine="postgres", access_mode="direct",
                           host="h", port=5432, database="d", username="u",
                           is_enabled=True, is_managed=False,
                           created_at=now, updated_at=now)
        db.add(other)
        db.flush()
        db.add(PreviewAllowlist(data_source_id=MANAGED_MSSQL_SOURCE_ID, schema="public",
                                note=None, added_by="test", created_at=now))
        db.commit()

        # Act / Assert: 같은 이름이어도 다른 소스는 여전히 차단
        assert is_preview_allowed(db, MANAGED_MSSQL_SOURCE_ID, "public") is True
        assert is_preview_allowed(db, other.id, "public") is False
