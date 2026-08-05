"""Schema→category mapping (DB 단위 분류).

Revision ID: 0010
Revises: 0009
Create Date: 2026-08-05

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0010"
down_revision: Union[str, None] = "0009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 스키마명이 키 — 재수집(새 스냅샷)해도 매핑이 살아남아야 한다
    op.create_table(
        "schema_categories",
        sa.Column("schema_name", sa.String(128), primary_key=True),
        sa.Column("category", sa.String(100), nullable=False),
        sa.Column("updated_by", sa.String(100), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("schema_categories")
