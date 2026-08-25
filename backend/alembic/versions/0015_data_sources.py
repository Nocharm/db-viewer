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


def downgrade() -> None:
    op.drop_table("data_sources")
