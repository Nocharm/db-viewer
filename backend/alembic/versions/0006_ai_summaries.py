"""Phase 5 — cached AI table summaries.

Revision ID: 0006
Revises: 0005
Create Date: 2026-08-01

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 텍스트 식별자 캐시 — 스냅샷 교체에도 요약 유지 / summary cache keyed by qname
    op.create_table(
        "ai_summaries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("object_qname", sa.String(261), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("object_qname", name="uq_ai_summaries_qname"),
    )


def downgrade() -> None:
    op.drop_table("ai_summaries")
