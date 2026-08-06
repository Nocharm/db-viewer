"""Admin-owned runtime toggles (관리 콘솔 런타임 플래그).

Revision ID: 0013
Revises: 0012
Create Date: 2026-08-06

첫 사용처는 감춘 스키마(`HIDDEN_SCHEMAS`)를 좌측 목록에 그릴지 여부다. 정책(어떤
스키마를 감출지)은 환경변수가 쥐고 있고 — 배포 권한 없이는 못 바꾼다 — 표시 방식만
운영 중에 토글한다. 행을 미리 넣지 않는다: 행이 없으면 호출부의 기본값(안 그림)이
적용되므로, 배포 직후부터 감춘 스키마는 목록에서 빠진 상태로 시작한다.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0013"
down_revision: Union[str, None] = "0012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "app_flags",
        sa.Column("key", sa.String(length=64), primary_key=True),
        sa.Column("value", sa.Boolean(), nullable=False),
        sa.Column("updated_by", sa.String(length=100), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    # 토글은 표시 방식일 뿐이라 되돌려도 정책(HIDDEN_SCHEMAS)은 그대로 살아 있다
    op.drop_table("app_flags")
