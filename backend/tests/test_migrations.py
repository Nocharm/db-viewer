"""Migration and schema integrity tests. / 마이그레이션·스키마 정합성 테스트."""

import os

import pytest
import sqlalchemy as sa
from alembic.autogenerate import compare_metadata
from alembic.runtime.migration import MigrationContext

from app.models import Base
from app.models.sources import MANAGED_MSSQL_SOURCE_ID
from tests.conftest import apply_migrations


def _insert_snapshot_tree(conn) -> tuple[int, int, int]:
    """Insert snapshot→object→column chain, return their ids. / 스냅샷 체인 삽입 후 id 반환."""
    t = Base.metadata.tables
    snap_id = conn.execute(
        t["snapshots"].insert().values(
            collected_at=sa.func.now(), source_db="fixture", status="ready",
            data_source_id=MANAGED_MSSQL_SOURCE_ID,
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
                collected_at=sa.func.now(), source_db="fixture", status="bogus",
                data_source_id=MANAGED_MSSQL_SOURCE_ID,
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


# ── PostgreSQL 전용 — 개발·테스트의 SQLite가 감추는 것들 ──

PG_URL = os.environ.get("TEST_POSTGRES_URL")
requires_pg = pytest.mark.skipif(not PG_URL, reason="TEST_POSTGRES_URL is not set")
# 대상 DB의 기존 객체를 건드리지 않도록 전용 스키마에 올렸다가 통째로 지운다
_PROBE_SCHEMA = "dbv_migration_probe"


@pytest.fixture()
def pg_probe_engine():
    engine = sa.create_engine(PG_URL)
    with engine.begin() as conn:
        conn.exec_driver_sql(f"DROP SCHEMA IF EXISTS {_PROBE_SCHEMA} CASCADE")
        conn.exec_driver_sql(f"CREATE SCHEMA {_PROBE_SCHEMA}")
    try:
        yield engine
    finally:
        # teardown은 assertion 실패에도 반드시 돈다 (test_pg_collector와 같은 관용)
        with engine.begin() as conn:
            conn.exec_driver_sql(f"DROP SCHEMA IF EXISTS {_PROBE_SCHEMA} CASCADE")
        engine.dispose()


@requires_pg
def test_seed_row_leaves_the_identity_sequence_past_it(pg_probe_engine):
    """0015의 시드 행(id 명시)이 SERIAL 시퀀스를 그대로 두면 첫 소스 등록이 PK 충돌한다.

    SQLite에서는 `INTEGER PRIMARY KEY`가 rowid 별칭이라 `max(rowid)+1`을 골라 이 사고가
    보이지 않는다 — 운영 엔진에서만 결정론적으로 터지므로 PostgreSQL에서만 확인 가능하다.
    """
    # Arrange: 프로브 스키마에 전체 마이그레이션 적용 (search_path로 격리)
    # `%`는 alembic ini의 보간 문법과 충돌한다 — 인코딩 없이 그대로 넘긴다
    separator = "&" if "?" in PG_URL else "?"
    apply_migrations(f"{PG_URL}{separator}options=-csearch_path={_PROBE_SCHEMA}")

    # Act: 시드 직후 시퀀스가 내주는 다음 id
    with pg_probe_engine.begin() as conn:
        conn.exec_driver_sql(f"SET search_path TO {_PROBE_SCHEMA}")
        next_id = conn.exec_driver_sql(
            "SELECT nextval('data_sources_id_seq')").scalar()

    # Assert: 시드 행(id=1)을 지나 있어야 관리자의 첫 등록이 성공한다
    assert next_id == 2
