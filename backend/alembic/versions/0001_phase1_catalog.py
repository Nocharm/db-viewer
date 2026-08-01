"""Phase 1 catalog schema — snapshots, objects, columns, constraints, lineage.

Revision ID: 0001
Revises:
Create Date: 2026-08-01

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "snapshots",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("collected_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source_db", sa.String(128), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.CheckConstraint(
            "status IN ('collecting', 'ready', 'failed')", name="ck_snapshots_status"
        ),
    )

    op.create_table(
        "objects",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("snapshot_id", sa.Integer(), nullable=False),
        sa.Column("schema", sa.String(128), nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("type", sa.String(8), nullable=False),
        sa.Column("object_id", sa.Integer(), nullable=False),
        sa.Column("row_count", sa.BigInteger(), nullable=True),
        sa.ForeignKeyConstraint(
            ["snapshot_id"], ["snapshots.id"],
            ondelete="CASCADE", name="fk_objects_snapshot_id",
        ),
        sa.CheckConstraint("type IN ('table', 'view')", name="ck_objects_type"),
        sa.UniqueConstraint("snapshot_id", "object_id", name="uq_objects_snapshot_object"),
    )
    op.create_index(
        "ix_objects_snapshot_schema_name", "objects", ["snapshot_id", "schema", "name"]
    )

    op.create_table(
        "columns",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("object_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("data_type", sa.String(128), nullable=False),
        sa.Column("max_length", sa.Integer(), nullable=False),
        sa.Column("is_nullable", sa.Boolean(), nullable=False),
        sa.Column("is_pk", sa.Boolean(), nullable=False),
        sa.Column("is_computed", sa.Boolean(), nullable=False),
        sa.Column("distinct_count", sa.BigInteger(), nullable=True),
        sa.Column("null_ratio", sa.Float(), nullable=True),
        sa.Column("masking_policy", sa.String(32), nullable=True),
        sa.ForeignKeyConstraint(
            ["object_id"], ["objects.id"],
            ondelete="CASCADE", name="fk_columns_object_id",
        ),
        sa.UniqueConstraint("object_id", "name", name="uq_columns_object_name"),
    )

    op.create_table(
        "constraints",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("snapshot_id", sa.Integer(), nullable=False),
        sa.Column("type", sa.String(4), nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.ForeignKeyConstraint(
            ["snapshot_id"], ["snapshots.id"],
            ondelete="CASCADE", name="fk_constraints_snapshot_id",
        ),
        sa.CheckConstraint("type IN ('pk', 'uq', 'fk')", name="ck_constraints_type"),
    )
    op.create_index("ix_constraints_snapshot", "constraints", ["snapshot_id"])

    op.create_table(
        "fk_columns",
        sa.Column("constraint_id", sa.Integer(), primary_key=True),
        sa.Column("src_column_id", sa.Integer(), primary_key=True),
        sa.Column("tgt_column_id", sa.Integer(), primary_key=True),
        sa.ForeignKeyConstraint(
            ["constraint_id"], ["constraints.id"],
            ondelete="CASCADE", name="fk_fk_columns_constraint_id",
        ),
        sa.ForeignKeyConstraint(
            ["src_column_id"], ["columns.id"],
            ondelete="CASCADE", name="fk_fk_columns_src_column_id",
        ),
        sa.ForeignKeyConstraint(
            ["tgt_column_id"], ["columns.id"],
            ondelete="CASCADE", name="fk_fk_columns_tgt_column_id",
        ),
    )

    op.create_table(
        "view_deps",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("snapshot_id", sa.Integer(), nullable=False),
        sa.Column("view_object_id", sa.Integer(), nullable=False),
        sa.Column("referenced_object_id", sa.Integer(), nullable=True),
        sa.Column("referenced_database", sa.String(128), nullable=True),
        sa.Column("referenced_name", sa.String(256), nullable=True),
        sa.Column("referenced_column", sa.String(128), nullable=True),
        sa.Column("is_resolved", sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(
            ["snapshot_id"], ["snapshots.id"],
            ondelete="CASCADE", name="fk_view_deps_snapshot_id",
        ),
        sa.ForeignKeyConstraint(
            ["view_object_id"], ["objects.id"],
            ondelete="CASCADE", name="fk_view_deps_view_object_id",
        ),
        sa.ForeignKeyConstraint(
            ["referenced_object_id"], ["objects.id"],
            name="fk_view_deps_referenced_object_id",
        ),
    )
    op.create_index(
        "ix_view_deps_snapshot_view", "view_deps", ["snapshot_id", "view_object_id"]
    )

    op.create_table(
        "view_lineage_flat",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("snapshot_id", sa.Integer(), nullable=False),
        sa.Column("view_object_id", sa.Integer(), nullable=False),
        sa.Column("view_column", sa.String(128), nullable=False),
        sa.Column("base_object_id", sa.Integer(), nullable=True),
        sa.Column("base_column", sa.String(128), nullable=True),
        sa.Column("depth", sa.Integer(), nullable=False),
        sa.Column("mapping_kind", sa.String(8), nullable=False),
        sa.Column("flag", sa.String(16), nullable=True),
        sa.ForeignKeyConstraint(
            ["snapshot_id"], ["snapshots.id"],
            ondelete="CASCADE", name="fk_vlf_snapshot_id",
        ),
        sa.ForeignKeyConstraint(
            ["view_object_id"], ["objects.id"],
            ondelete="CASCADE", name="fk_vlf_view_object_id",
        ),
        sa.ForeignKeyConstraint(
            ["base_object_id"], ["objects.id"], name="fk_vlf_base_object_id"
        ),
        sa.CheckConstraint(
            "mapping_kind IN ('direct', 'set', 'derived')", name="ck_vlf_mapping_kind"
        ),
        sa.CheckConstraint("flag IN ('cycle', 'depth_exceeded')", name="ck_vlf_flag"),
    )
    op.create_index(
        "ix_vlf_snapshot_view", "view_lineage_flat", ["snapshot_id", "view_object_id"]
    )
    op.create_index("ix_vlf_base_object", "view_lineage_flat", ["base_object_id"])


def downgrade() -> None:
    op.drop_table("view_lineage_flat")
    op.drop_table("view_deps")
    op.drop_table("fk_columns")
    op.drop_table("constraints")
    op.drop_table("columns")
    op.drop_table("objects")
    op.drop_table("snapshots")
