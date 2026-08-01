"""Phase 3 — relations, validation history, audit logs.

Revision ID: 0004
Revises: 0003
Create Date: 2026-08-01

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 텍스트 식별자 — 스냅샷 삭제에도 이력 보존 / textual identity survives snapshot churn
    op.create_table(
        "relations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("src_object", sa.String(261), nullable=False),
        sa.Column("src_column", sa.String(128), nullable=False),
        sa.Column("tgt_object", sa.String(261), nullable=False),
        sa.Column("tgt_column", sa.String(128), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("origin", sa.String(16), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("cardinality", sa.String(8), nullable=True),
        sa.Column("last_verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "status IN ('candidate', 'validated', 'confirmed', 'rejected')",
            name="ck_relations_status",
        ),
        sa.CheckConstraint(
            "origin IN ('rule', 'view_join', 'ai', 'user')", name="ck_relations_origin"
        ),
        sa.UniqueConstraint(
            "src_object", "src_column", "tgt_object", "tgt_column",
            name="uq_relations_pair",
        ),
    )

    op.create_table(
        "join_validation_history",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("src_object", sa.String(261), nullable=False),
        sa.Column("src_column", sa.String(128), nullable=False),
        sa.Column("tgt_object", sa.String(261), nullable=False),
        sa.Column("tgt_column", sa.String(128), nullable=False),
        sa.Column("containment", sa.Float(), nullable=False),
        sa.Column("orphan_count", sa.Integer(), nullable=False),
        sa.Column("cardinality", sa.String(8), nullable=False),
        sa.Column("src_row_count", sa.BigInteger(), nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("triggered_by", sa.String(64), nullable=False),
    )
    op.create_index(
        "ix_jvh_pair", "join_validation_history",
        ["src_object", "src_column", "tgt_object", "tgt_column"],
    )

    op.create_table(
        "audit_logs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("action", sa.String(32), nullable=False),
        sa.Column("detail", sa.String(600), nullable=False),
        sa.Column("requested_by", sa.String(64), nullable=False),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("audit_logs")
    op.drop_index("ix_jvh_pair", "join_validation_history")
    op.drop_table("join_validation_history")
    op.drop_table("relations")
