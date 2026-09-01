"""Preview allowlist and schema categories become per-source (노출 정책 소스별 분리).

Revision ID: 0017
Revises: 0016
Create Date: 2026-08-25

같은 스키마명이 서로 다른 소스에 존재할 수 있다('public'). 소스 축이 없으면 한쪽을
허용한 것이 다른 쪽까지 여는 사고가 난다. PK 변경은 SQLite가 ALTER를 지원하지 않으므로
새 테이블 생성 → 복사 → 교체로 쓴다.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "0017"
down_revision: Union[str, None] = "0016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

MANAGED_SOURCE_ID = 1


def upgrade() -> None:
    op.create_table(
        "preview_allowlist_new",
        sa.Column("data_source_id", sa.Integer(), primary_key=True),
        sa.Column("schema", sa.String(128), primary_key=True),
        sa.Column("note", sa.String(300), nullable=True),
        sa.Column("added_by", sa.String(100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.execute(
        f'INSERT INTO preview_allowlist_new (data_source_id, "schema", note, added_by, created_at) '
        f'SELECT {MANAGED_SOURCE_ID}, "schema", note, added_by, created_at FROM preview_allowlist'
    )
    op.drop_table("preview_allowlist")
    op.rename_table("preview_allowlist_new", "preview_allowlist")

    op.create_table(
        "schema_categories_new",
        sa.Column("data_source_id", sa.Integer(), primary_key=True),
        sa.Column("schema_name", sa.String(128), primary_key=True),
        sa.Column("category", sa.String(100), nullable=False),
        sa.Column("updated_by", sa.String(100), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.execute(
        f"INSERT INTO schema_categories_new "
        f"(data_source_id, schema_name, category, updated_by, updated_at) "
        f"SELECT {MANAGED_SOURCE_ID}, schema_name, category, updated_by, updated_at "
        f"FROM schema_categories"
    )
    op.drop_table("schema_categories")
    op.rename_table("schema_categories_new", "schema_categories")


def downgrade() -> None:
    op.create_table(
        "preview_allowlist_old",
        sa.Column("schema", sa.String(128), primary_key=True),
        sa.Column("note", sa.String(300), nullable=True),
        sa.Column("added_by", sa.String(100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.execute(
        f'INSERT INTO preview_allowlist_old ("schema", note, added_by, created_at) '
        f'SELECT "schema", note, added_by, created_at FROM preview_allowlist '
        f"WHERE data_source_id = {MANAGED_SOURCE_ID}"
    )
    op.drop_table("preview_allowlist")
    op.rename_table("preview_allowlist_old", "preview_allowlist")

    op.create_table(
        "schema_categories_old",
        sa.Column("schema_name", sa.String(128), primary_key=True),
        sa.Column("category", sa.String(100), nullable=False),
        sa.Column("updated_by", sa.String(100), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.execute(
        f"INSERT INTO schema_categories_old (schema_name, category, updated_by, updated_at) "
        f"SELECT schema_name, category, updated_by, updated_at FROM schema_categories "
        f"WHERE data_source_id = {MANAGED_SOURCE_ID}"
    )
    op.drop_table("schema_categories")
    op.rename_table("schema_categories_old", "schema_categories")
