"""Per-column TOP-N sample stats for the join gate (조인 게이트용 컬럼 샘플 통계).

Revision ID: 0014
Revises: 0013
Create Date: 2026-08-07

게이트는 TOP 200 샘플의 distinct 비율로 m:n 페어를 전수 containment 전에 걸러낸다.
샘플 통계는 페어가 아니라 컬럼의 속성이므로 컬럼에 캐시한다 — 같은 컬럼을 다른 상대와
재검증할 때 재쿼리가 없다. distinct_count(전수, T2 관측)와 축이 다르다: 이쪽은 표본이다.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0014"
down_revision: Union[str, None] = "0013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("columns", sa.Column("sample_rows", sa.Integer(), nullable=True))
    op.add_column("columns", sa.Column("sample_distinct", sa.Integer(), nullable=True))
    op.add_column("columns", sa.Column("sampled_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("columns", "sampled_at")
    op.drop_column("columns", "sample_distinct")
    op.drop_column("columns", "sample_rows")
