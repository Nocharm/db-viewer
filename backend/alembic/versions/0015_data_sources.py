"""Registered data sources (조회 대상 DB 소스 등록부).

Revision ID: 0015
Revises: 0014
Create Date: 2026-08-25

사내 MSSQL도 소스 1건(id=1, is_managed)으로 시드한다 — 소스별 분기에서 NULL 특례를
만들지 않기 위해서다. 접속정보는 여전히 .env/n8n에 있고 이 행은 라벨·라우팅 표식만 담는다.
"""

from datetime import UTC, datetime
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "0015"
down_revision: Union[str, None] = "0014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    sources = op.create_table(
        "data_sources",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False, unique=True),
        sa.Column("engine", sa.String(16), nullable=False),
        sa.Column("access_mode", sa.String(8), nullable=False),
        sa.Column("host", sa.String(255), nullable=True),
        sa.Column("port", sa.Integer(), nullable=True),
        sa.Column("database", sa.String(128), nullable=True),
        sa.Column("username", sa.String(128), nullable=True),
        sa.Column("password_enc", sa.Text(), nullable=True),
        sa.Column("file_path", sa.String(500), nullable=True),
        sa.Column("is_enabled", sa.Boolean(), nullable=False),
        sa.Column("is_managed", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_ok_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.CheckConstraint("engine IN ('mssql', 'postgres', 'sqlite')",
                           name="ck_data_sources_engine"),
        sa.CheckConstraint("access_mode IN ('n8n', 'direct')",
                           name="ck_data_sources_access_mode"),
    )
    now = datetime.now(UTC)
    op.bulk_insert(sources, [{
        "id": 1, "name": "사내 MSSQL", "engine": "mssql", "access_mode": "n8n",
        "host": None, "port": None, "database": None, "username": None,
        "password_enc": None, "file_path": None,
        "is_enabled": True, "is_managed": True,
        "created_at": now, "updated_at": now, "last_ok_at": None, "last_error": None,
    }])
    # id를 명시한 INSERT는 시퀀스를 전진시키지 않는다 — PostgreSQL에서 SERIAL로 렌더되는
    # 이 컬럼의 다음 nextval이 여전히 1이라, 관리자가 처음 등록하는 소스가 시드 행과 PK
    # 충돌한다(운영 첫 동작이 결정론적으로 깨진다). SQLite는 INTEGER PRIMARY KEY가 rowid
    # 별칭이라 max(rowid)+1을 골라 이 사고를 감춘다 — 그래서 테스트로는 안 잡힌다.
    # / an explicit-id insert leaves the SERIAL sequence at 1; SQLite's rowid alias hides it
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SELECT setval('data_sources_id_seq', "
                   "(SELECT MAX(id) FROM data_sources))")


def downgrade() -> None:
    op.drop_table("data_sources")
