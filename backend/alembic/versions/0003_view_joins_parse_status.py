"""Phase 2 — view_joins table and parse status on objects.

Revision ID: 0003
Revises: 0002
Create Date: 2026-08-01

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "view_joins",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("snapshot_id", sa.Integer(), nullable=False),
        sa.Column("view_object_id", sa.Integer(), nullable=False),
        sa.Column("left_column_id", sa.Integer(), nullable=False),
        sa.Column("right_column_id", sa.Integer(), nullable=False),
        sa.Column("join_type", sa.String(16), nullable=False),
        sa.Column("occurrence_count", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["snapshot_id"], ["snapshots.id"],
            ondelete="CASCADE", name="fk_view_joins_snapshot_id",
        ),
        sa.ForeignKeyConstraint(
            ["view_object_id"], ["objects.id"],
            ondelete="CASCADE", name="fk_view_joins_view_object_id",
        ),
        sa.ForeignKeyConstraint(
            ["left_column_id"], ["columns.id"],
            ondelete="CASCADE", name="fk_view_joins_left_column_id",
        ),
        sa.ForeignKeyConstraint(
            ["right_column_id"], ["columns.id"],
            ondelete="CASCADE", name="fk_view_joins_right_column_id",
        ),
    )
    op.create_index("ix_view_joins_snapshot_view", "view_joins", ["snapshot_id", "view_object_id"])
    op.create_index("ix_view_joins_columns", "view_joins", ["left_column_id", "right_column_id"])

    op.add_column("objects", sa.Column("parse_status", sa.String(16), nullable=True))
    op.add_column("objects", sa.Column("parse_error", sa.Text(), nullable=True))
    with op.batch_alter_table("objects") as batch:
        batch.create_check_constraint(
            "ck_objects_parse_status",
            "parse_status IN ('ok', 'partial', 'unsupported', 'parse_failed')",
        )


def downgrade() -> None:
    with op.batch_alter_table("objects") as batch:
        batch.drop_constraint("ck_objects_parse_status")
    op.drop_column("objects", "parse_error")
    op.drop_column("objects", "parse_status")
    op.drop_index("ix_view_joins_columns", "view_joins")
    op.drop_index("ix_view_joins_snapshot_view", "view_joins")
    op.drop_table("view_joins")
