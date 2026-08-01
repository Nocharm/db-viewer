"""Auth — app users (AD sync) and login whitelist.

Revision ID: 0007
Revises: 0006
Create Date: 2026-08-01

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0007"
down_revision: Union[str, None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "app_users",
        sa.Column("login_id", sa.String(100), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("title", sa.String(100), nullable=True),
        sa.Column("department", sa.String(200), nullable=True),
        sa.Column("org_path", sa.String(600), nullable=True),
        sa.Column("email", sa.String(200), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("source", sa.String(10), nullable=False),
        sa.Column("role", sa.String(10), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("source IN ('ad', 'local')", name="ck_app_users_source"),
        sa.CheckConstraint("role IN ('admin', 'user')", name="ck_app_users_role"),
    )
    op.create_table(
        "login_whitelist",
        sa.Column("login_id", sa.String(100), primary_key=True),
        sa.Column("note", sa.String(200), nullable=True),
        sa.Column("added_by", sa.String(100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("login_whitelist")
    op.drop_table("app_users")
