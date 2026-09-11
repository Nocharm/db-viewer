"""Audit log: target column (감사 로그 대상 컬럼).

Revision ID: 0020
Revises: 0019
Create Date: 2026-09-12

감사 화면의 요청자·대상 드롭다운 축. 기존 행은 detail의 첫 토큰(테이블명·login_id·소스명)이
곧 대상이었으므로 그 값으로 백필한다.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "0020"
down_revision: Union[str, None] = "0019"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("audit_logs") as batch:
        batch.add_column(sa.Column("target", sa.String(length=300), nullable=True))
    # 파이썬 백필 — SQLite/PostgreSQL 공통 문자열 함수가 없어 DB별 SQL을 나누지 않는다
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, detail FROM audit_logs")).fetchall()
    for row_id, detail in rows:
        target = (detail or "").split(" ", 1)[0][:300] or None
        conn.execute(sa.text("UPDATE audit_logs SET target = :t WHERE id = :i"),
                     {"t": target, "i": row_id})


def downgrade() -> None:
    with op.batch_alter_table("audit_logs") as batch:
        batch.drop_column("target")
