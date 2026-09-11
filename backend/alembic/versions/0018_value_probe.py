"""Value probe jobs, targets and hits (값 추적 잡·대상·히트).

Revision ID: 0018
Revises: 0017
Create Date: 2026-09-10

계획을 행으로 남긴다 — 진행률·heavy 목록·선택 실행·재시작 복원이 대상 행에서 나온다.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "0018"
down_revision: Union[str, None] = "0017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "value_probe_jobs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("data_source_id", sa.Integer(), nullable=False),
        sa.Column("snapshot_id", sa.Integer(), nullable=False),
        sa.Column("value", sa.String(100), nullable=False),
        sa.Column("mode", sa.String(12), nullable=False),
        sa.Column("hint", sa.String(128), nullable=True),
        sa.Column("schemas", sa.Text(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("progress_total", sa.Integer(), nullable=False),
        sa.Column("progress_done", sa.Integer(), nullable=False),
        sa.Column("cancel_requested", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("current_qname", sa.String(261), nullable=True),
        sa.Column("triggered_by", sa.String(64), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('queued', 'running', 'done', 'failed', 'cancelled')",
            name="ck_value_probe_jobs_status",
        ),
        sa.CheckConstraint(
            "mode IN ('normalized', 'exact', 'contains')", name="ck_value_probe_jobs_mode"
        ),
    )
    op.create_table(
        "value_probe_targets",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("job_id", sa.Integer(), nullable=False),
        sa.Column("object_id", sa.Integer(), nullable=False),
        sa.Column("qname", sa.String(261), nullable=False),
        sa.Column("object_type", sa.String(5), nullable=False),
        sa.Column("columns", sa.Text(), nullable=False),
        sa.Column("tier", sa.String(5), nullable=False),
        sa.Column("heavy_reason", sa.String(32), nullable=True),
        sa.Column("rank", sa.Integer(), nullable=False),
        sa.Column("est_rows", sa.BigInteger(), nullable=True),
        sa.Column("status", sa.String(8), nullable=False),
        sa.Column("error", sa.String(200), nullable=True),
        sa.ForeignKeyConstraint(["job_id"], ["value_probe_jobs.id"], ondelete="CASCADE",
                                name="fk_value_probe_targets_job_id"),
        sa.CheckConstraint("tier IN ('auto', 'heavy')", name="ck_value_probe_targets_tier"),
        sa.CheckConstraint(
            "status IN ('pending', 'done', 'skipped', 'error', 'timeout')",
            name="ck_value_probe_targets_status",
        ),
    )
    op.create_index("ix_value_probe_targets_job_rank", "value_probe_targets", ["job_id", "rank"])
    op.create_table(
        "value_probe_hits",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("job_id", sa.Integer(), nullable=False),
        sa.Column("target_id", sa.Integer(), nullable=False),
        sa.Column("object_id", sa.Integer(), nullable=False),
        sa.Column("object_type", sa.String(5), nullable=False),
        sa.Column("qname", sa.String(261), nullable=False),
        sa.Column("column_name", sa.String(128), nullable=False),
        sa.Column("match_count", sa.Integer(), nullable=True),
        sa.Column("count_capped", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("matched_variant", sa.String(100), nullable=False),
        sa.ForeignKeyConstraint(["job_id"], ["value_probe_jobs.id"], ondelete="CASCADE",
                                name="fk_value_probe_hits_job_id"),
        sa.ForeignKeyConstraint(["target_id"], ["value_probe_targets.id"], ondelete="CASCADE",
                                name="fk_value_probe_hits_target_id"),
    )
    op.create_index("ix_value_probe_hits_job", "value_probe_hits", ["job_id"])


def downgrade() -> None:
    op.drop_index("ix_value_probe_hits_job", table_name="value_probe_hits")
    op.drop_table("value_probe_hits")
    op.drop_index("ix_value_probe_targets_job_rank", table_name="value_probe_targets")
    op.drop_table("value_probe_targets")
    op.drop_table("value_probe_jobs")
