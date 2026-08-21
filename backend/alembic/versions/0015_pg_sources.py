"""Registered business-Postgres connections (업무 Postgres 연결 목록).

Revision ID: 0015
Revises: 0014
Create Date: 2026-08-21

연결 대상이 서비스마다 늘어나 .env 한 줄로는 못 담는다 — 관리 콘솔에서 추가·수정·
삭제하도록 표로 옮긴다. 비밀번호는 `PG_SOURCE_SECRET`으로 암호화한 문자열만 저장하며,
키가 없으면 등록도 사용도 막힌다(fail closed). 허용 스키마는 기존 preview_allowlist를
그대로 쓰고 키만 `pg:<slug>:<schema>` 형태로 네임스페이스한다.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0015"
down_revision: Union[str, None] = "0014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "pg_sources",
        sa.Column("slug", sa.String(length=40), primary_key=True),
        sa.Column("label", sa.String(length=100), nullable=False),
        sa.Column("host", sa.String(length=200), nullable=False),
        sa.Column("port", sa.Integer(), nullable=False),
        sa.Column("database", sa.String(length=128), nullable=False),
        sa.Column("username", sa.String(length=128), nullable=False),
        sa.Column("password_enc", sa.Text(), nullable=False),
        sa.Column("note", sa.String(length=300), nullable=True),
        sa.Column("created_by", sa.String(length=100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    # 허용 행(`pg:…`)은 preview_allowlist에 남는다 — 연결이 없으면 아무것도 열지 않으므로 무해
    op.drop_table("pg_sources")
