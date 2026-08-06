"""Preview allowlist keyed by schema (미리보기 허용을 스키마 단위로).

Revision ID: 0012
Revises: 0011
Create Date: 2026-08-06

기존 qname("schema.name") 행은 그 스키마 1건으로 접힌다. **노출 범위가 넓어지는
변환이다** — 테이블 하나만 열려 있던 스키마가 통째로 열린다. 정책을 스키마 단위로
바꾼다는 결정에 따른 것이고, 좁히려면 업그레이드 후 관리 콘솔에서 해당 스키마를 뺀다.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0012"
down_revision: Union[str, None] = "0011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(sa.text(
        "SELECT qname, note, added_by, created_at FROM preview_allowlist ORDER BY qname"
    )).fetchall()

    op.create_table(
        "preview_allowlist_new",
        sa.Column("schema", sa.String(128), primary_key=True),
        sa.Column("note", sa.String(300), nullable=True),
        sa.Column("added_by", sa.String(100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    # 스키마 접기는 SQL 문자열 함수가 방언마다 달라 파이썬에서 한다 / dialect-agnostic fold
    folded: dict[str, tuple[str | None, str, object]] = {}
    for qname, note, added_by, created_at in rows:
        schema = qname.split(".", 1)[0]
        if schema not in folded:  # 같은 스키마의 첫 행이 대표 (qname 순 = 결정적)
            folded[schema] = (note, added_by, created_at)
    if folded:
        conn.execute(
            sa.text("INSERT INTO preview_allowlist_new (schema, note, added_by, created_at)"
                    " VALUES (:schema, :note, :added_by, :created_at)"),
            [{"schema": schema, "note": note, "added_by": added_by, "created_at": created_at}
             for schema, (note, added_by, created_at) in folded.items()],
        )

    op.drop_table("preview_allowlist")
    op.rename_table("preview_allowlist_new", "preview_allowlist")


def downgrade() -> None:
    # 스키마 → qname 복원은 불가능하다 (어느 테이블이 열려 있었는지 정보가 없다).
    # 전부 차단이 기본 정책이라 빈 표로 되돌린다 / no data to restore; fall back to deny-all
    op.drop_table("preview_allowlist")
    op.create_table(
        "preview_allowlist",
        sa.Column("qname", sa.String(257), primary_key=True),
        sa.Column("note", sa.String(300), nullable=True),
        sa.Column("added_by", sa.String(100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
