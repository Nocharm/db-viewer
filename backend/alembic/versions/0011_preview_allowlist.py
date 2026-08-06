"""Preview allowlist (미리보기 허용 테이블).

Revision ID: 0011
Revises: 0010
Create Date: 2026-08-06

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0011"
down_revision: Union[str, None] = "0010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # qname이 키 — 재수집(새 스냅샷)해도 허용 목록이 살아남아야 한다.
    # 빈 표 = 전부 차단이 기본 정책이라 초기 데이터는 넣지 않는다.
    op.create_table(
        "preview_allowlist",
        sa.Column("qname", sa.String(257), primary_key=True),
        sa.Column("note", sa.String(300), nullable=True),
        sa.Column("added_by", sa.String(100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("preview_allowlist")
