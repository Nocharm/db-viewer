"""Migration and schema integrity tests. / 마이그레이션·스키마 정합성 테스트."""

from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.runtime.migration import MigrationContext

from app.models import Base

BACKEND_DIR = Path(__file__).resolve().parents[1]


@pytest.fixture()
def migrated_engine(tmp_path):
    # Arrange: 마이그레이션 적용된 임시 SQLite / fresh SQLite with all migrations applied
    url = f"sqlite:///{tmp_path / 'test.db'}"
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)
    command.upgrade(cfg, "head")
    engine = sa.create_engine(url)
    yield engine
    engine.dispose()


@pytest.fixture()
def fk_conn(migrated_engine):
    # SQLite는 FK 강제가 기본 꺼짐 — 테스트에서만 명시적으로 켠다
    # SQLite disables FK enforcement by default; enable per-connection for tests
    conn = migrated_engine.connect()
    conn.exec_driver_sql("PRAGMA foreign_keys=ON")
    yield conn
    conn.close()


def _insert_snapshot_tree(conn) -> tuple[int, int, int]:
    """Insert snapshot→object→column chain, return their ids. / 스냅샷 체인 삽입 후 id 반환."""
    t = Base.metadata.tables
    snap_id = conn.execute(
        t["snapshots"].insert().values(
            collected_at=sa.func.now(), source_db="fixture", status="ready"
        )
    ).inserted_primary_key[0]
    obj_id = conn.execute(
        t["objects"].insert().values(
            snapshot_id=snap_id, schema="dbo", name="EMPLOYEE",
            type="table", object_id=1001, row_count=42,
        )
    ).inserted_primary_key[0]
    col_id = conn.execute(
        t["columns"].insert().values(
            object_id=obj_id, name="EMP_NO", ordinal=1, data_type="int",
            max_length=4, is_nullable=False, is_pk=True, is_computed=False,
        )
    ).inserted_primary_key[0]
    return snap_id, obj_id, col_id


def test_upgrade_creates_all_tables(migrated_engine):
    insp = sa.inspect(migrated_engine)
    expected = set(Base.metadata.tables) | {"alembic_version"}
    assert set(insp.get_table_names()) == expected


def test_migration_matches_models(migrated_engine):
    # 마이그레이션 산출 스키마와 모델 정의가 어긋나면 diff가 나온다
    # any drift between migration output and models shows up as diff ops
    with migrated_engine.connect() as conn:
        ctx = MigrationContext.configure(conn, opts={"compare_type": False})
        diff = compare_metadata(ctx, Base.metadata)
    assert diff == []


def test_snapshot_cascade_delete(fk_conn):
    snap_id, _, _ = _insert_snapshot_tree(fk_conn)
    t = Base.metadata.tables

    fk_conn.execute(t["snapshots"].delete().where(t["snapshots"].c.id == snap_id))

    remaining_objects = fk_conn.execute(
        sa.select(sa.func.count()).select_from(t["objects"])
    ).scalar()
    remaining_columns = fk_conn.execute(
        sa.select(sa.func.count()).select_from(t["columns"])
    ).scalar()
    assert (remaining_objects, remaining_columns) == (0, 0)


def test_status_check_constraint_rejects_unknown(fk_conn):
    with pytest.raises(sa.exc.IntegrityError):
        fk_conn.execute(
            Base.metadata.tables["snapshots"].insert().values(
                collected_at=sa.func.now(), source_db="fixture", status="bogus"
            )
        )


def test_unresolved_view_dep_keeps_textual_identity(fk_conn):
    # 미해석 참조는 referenced_object_id NULL + 이름 보존 (Phase 2 재해석 입력)
    # unresolved refs keep NULL object id + textual name for Phase 2 re-resolution
    snap_id, obj_id, _ = _insert_snapshot_tree(fk_conn)
    t = Base.metadata.tables
    fk_conn.execute(
        t["view_deps"].insert().values(
            snapshot_id=snap_id, view_object_id=obj_id,
            referenced_object_id=None, referenced_database="OTHER_DB",
            referenced_name="dbo.REMOTE_TABLE", referenced_column=None,
            is_resolved=False,
        )
    )
    row = fk_conn.execute(sa.select(t["view_deps"])).one()
    assert row.is_resolved is False
    assert row.referenced_name == "dbo.REMOTE_TABLE"
