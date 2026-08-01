"""Phase 4 — scan jobs and results.

Revision ID: 0005
Revises: 0004
Create Date: 2026-08-01

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "scan_jobs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("src_object", sa.String(261), nullable=False),
        sa.Column("src_column", sa.String(128), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("progress_total", sa.Integer(), nullable=False),
        sa.Column("progress_done", sa.Integer(), nullable=False),
        sa.Column("night_only", sa.Boolean(), nullable=False),
        sa.Column("not_before", sa.DateTime(timezone=True), nullable=True),
        sa.Column("triggered_by", sa.String(64), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('queued', 'running', 'done', 'failed')", name="ck_scan_jobs_status"
        ),
    )
    op.create_table(
        "scan_results",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("job_id", sa.Integer(), nullable=False),
        sa.Column("tgt_object", sa.String(261), nullable=False),
        sa.Column("tgt_column", sa.String(128), nullable=False),
        sa.Column("containment_sample", sa.Float(), nullable=False),
        sa.Column("containment_full", sa.Float(), nullable=True),
        sa.Column("cardinality", sa.String(8), nullable=True),
        sa.Column("rank", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["job_id"], ["scan_jobs.id"],
            ondelete="CASCADE", name="fk_scan_results_job_id",
        ),
    )
    op.create_index("ix_scan_results_job", "scan_results", ["job_id"])


def downgrade() -> None:
    op.drop_index("ix_scan_results_job", "scan_results")
    op.drop_table("scan_results")
    op.drop_table("scan_jobs")
