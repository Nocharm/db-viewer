"""AI cycle 2 schema — relation reason, embeddings, AI jobs.

Revision ID: 0009
Revises: 0008
Create Date: 2026-08-05

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0009"
down_revision: Union[str, None] = "0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("relations", sa.Column("reason", sa.Text(), nullable=True))
    op.create_table(
        "ai_embeddings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("object_qname", sa.String(261), nullable=False),
        sa.Column("model", sa.String(128), nullable=False),
        sa.Column("vector", sa.Text(), nullable=False),
        sa.Column("source_hash", sa.String(64), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("object_qname", name="uq_ai_embeddings_qname"),
    )
    op.create_table(
        "ai_jobs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("progress_done", sa.Integer(), nullable=False),
        sa.Column("progress_total", sa.Integer(), nullable=False),
        sa.Column("result", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("triggered_by", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("kind IN ('suggest', 'embed_index')", name="ck_ai_jobs_kind"),
        sa.CheckConstraint(
            "status IN ('queued', 'running', 'done', 'failed')", name="ck_ai_jobs_status"
        ),
    )


def downgrade() -> None:
    op.drop_table("ai_jobs")
    op.drop_table("ai_embeddings")
    op.drop_column("relations", "reason")
