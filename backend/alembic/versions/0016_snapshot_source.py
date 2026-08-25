"""Snapshots hang off a data source (스냅샷에 소스 축 추가).

Revision ID: 0016
Revises: 0015
Create Date: 2026-08-25

기존 스냅샷은 전부 시드된 사내 MSSQL 소스로 백필한다 — nullable로 추가 → 백필 →
NOT NULL 순서를 지켜야 기존 데이터가 있는 배포에서 마이그레이션이 통과한다.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "0016"
down_revision: Union[str, None] = "0015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

MANAGED_SOURCE_ID = 1


def upgrade() -> None:
    op.add_column("snapshots", sa.Column("data_source_id", sa.Integer(), nullable=True))
    op.execute(f"UPDATE snapshots SET data_source_id = {MANAGED_SOURCE_ID} "
               "WHERE data_source_id IS NULL")
    # SQLite는 ALTER로 nullable을 못 바꾼다 — batch로 테이블을 재작성한다
    with op.batch_alter_table("snapshots") as batch:
        batch.alter_column("data_source_id", existing_type=sa.Integer(), nullable=False)
        batch.create_foreign_key("fk_snapshots_data_source_id", "data_sources",
                                 ["data_source_id"], ["id"])
    op.create_index("ix_snapshots_source_status", "snapshots",
                    ["data_source_id", "status", "id"])


def downgrade() -> None:
    op.drop_index("ix_snapshots_source_status", table_name="snapshots")
    with op.batch_alter_table("snapshots") as batch:
        batch.drop_constraint("fk_snapshots_data_source_id", type_="foreignkey")
        batch.drop_column("data_source_id")
