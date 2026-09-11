"""Value probe: related-view option columns (값 추적 연관 뷰 옵션).

Revision ID: 0019
Revises: 0018
Create Date: 2026-09-11

선택 스키마 밖의 뷰를 lineage로 찾아 포함할 때, 자동 포함된 스키마와 정책으로 제외된 뷰를
잡 행에 남긴다 — 실행 직전 게이트 재검사와 화면 표시의 근거다.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "0019"
down_revision: Union[str, None] = "0018"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("value_probe_jobs") as batch:
        batch.add_column(sa.Column("include_related_views", sa.Boolean(), nullable=False,
                                   server_default=sa.false()))
        batch.add_column(sa.Column("related_schemas", sa.Text(), nullable=False,
                                   server_default="[]"))
        batch.add_column(sa.Column("related_skipped", sa.Text(), nullable=False,
                                   server_default="[]"))


def downgrade() -> None:
    with op.batch_alter_table("value_probe_jobs") as batch:
        batch.drop_column("related_skipped")
        batch.drop_column("related_schemas")
        batch.drop_column("include_related_views")
