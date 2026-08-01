"""Store view DDL and DMV-failure flag on objects.

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-01

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Phase 2 파싱 입력을 영속화 — raw POST는 재조회 불가 / persist Phase 2 parser input
    op.add_column("objects", sa.Column("definition", sa.Text(), nullable=True))
    op.add_column(
        "objects",
        sa.Column("dmv_unresolved", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("objects", "dmv_unresolved")
    op.drop_column("objects", "definition")
