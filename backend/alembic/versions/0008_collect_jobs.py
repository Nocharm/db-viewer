"""Button-triggered collection jobs.

Revision ID: 0008
Revises: 0007
Create Date: 2026-08-01

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0008"
down_revision: Union[str, None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "collect_jobs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("mode", sa.String(8), nullable=False),
        sa.Column("stage", sa.String(20), nullable=False),
        sa.Column("snapshot_id", sa.Integer(), nullable=True),
        sa.Column("counts", sa.Text(), nullable=True),
        sa.Column("triggered_by", sa.String(64), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "stage IN ('catalog_running', 'catalog_done', 'deps_running', 'ready', 'failed')",
            name="ck_collect_jobs_stage",
        ),
        sa.CheckConstraint("mode IN ('step', 'full')", name="ck_collect_jobs_mode"),
    )


def downgrade() -> None:
    op.drop_table("collect_jobs")
