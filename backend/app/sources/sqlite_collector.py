"""SQLite catalog collector. / SQLite 카탈로그 수집기.

SQLite에는 스키마도 object_id도 없다 — 스키마는 'main' 고정, object_id는 스냅샷 내
일련번호로 만든다(계약은 스냅샷 안에서의 유일성만 요구한다).
PRAGMA는 바인드 파라미터를 못 받는다 — 이름은 sqlite_master에서 읽은 값이지만
그래도 식별자 인용으로 감싸 넣는다.
"""

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import Engine, text

from app.schemas.ingest import (
    CatalogPayload,
    RawColumn,
    RawForeignKey,
    RawFkPair,
    RawKeyConstraint,
    RawObject,
    RawViewDefinition,
)
from app.sources.preview_sql import quote_ident

SQLITE_SCHEMA = "main"

# `CatalogConstraint.name` 컬럼 길이 / the constraint-name column width.
# SQLite에는 식별자 길이 제한이 없어 이름을 조합하면 이 폭을 넘길 수 있다. 넘기면
# PostgreSQL(운영 DB)은 "value too long for type character varying(128)"으로 적재를 통째로
# 실패시키고, SQLite(개발·테스트)는 조용히 받아준다 — 그래서 여기서 맞춰 넣는다.
_CONSTRAINT_NAME_LIMIT = 128

_OBJECTS_SQL = (
    "SELECT type, name, sql FROM sqlite_master "
    "WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' "
    "ORDER BY type, name"
)


def build_fk_name(src_name: str, tgt_name: str, fk_id: int) -> str:
    """`{src}_{tgt}_{id}` — 컬럼 폭을 넘으면 테이블명만 줄인다 / trims the table names only.

    `_{id}` 접미사는 무슨 일이 있어도 남긴다: 한 테이블이 같은 대상으로 FK를 여러 개
    걸었을 때 이름을 구분하는 유일한 조각이다. 짧은 쪽이 안 쓴 자리는 긴 쪽에 넘겨,
    잘라야 할 때도 가능한 한 많은 원래 이름이 남고 결과가 결정론적이도록 한다.
    """
    suffix = f"_{fk_id}"
    budget = _CONSTRAINT_NAME_LIMIT - len(suffix) - 1  # 두 이름 사이의 '_' 한 칸
    src_keep = min(len(src_name), budget // 2)
    tgt_keep = min(len(tgt_name), budget - src_keep)
    src_keep = min(len(src_name), budget - tgt_keep)  # 대상명이 남긴 몫을 되돌려준다
    return f"{src_name[:src_keep]}_{tgt_name[:tgt_keep]}{suffix}"


def _collect_primary_key(columns: list[dict[str, Any]]) -> list[str]:
    """table_info의 pk 필드는 0이면 비PK, 아니면 복합키 내 1-base 순번이다."""
    return [c["name"] for c in sorted((c for c in columns if c["pk"]),
                                      key=lambda c: c["pk"])]


def _group_foreign_keys(rows: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """foreign_key_list를 id로 묶고 각 그룹을 seq로 정렬한다 — 복합 FK 페어 순서 보존."""
    grouped: dict[int, list[dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(row["id"], []).append(row)
    return [sorted(group, key=lambda item: item["seq"]) for group in grouped.values()]


def _resolve_fk_pairs(
    group: list[dict[str, Any]], target_pk: list[str],
) -> list[RawFkPair] | None:
    """`to`가 NULL이면 대상 PK의 같은 자리로 해석한다. 하나라도 못 풀면 전체를 버린다(None)."""
    pairs: list[RawFkPair] = []
    for position, item in enumerate(group):
        target_column = item["to"]
        if target_column is None:
            target_column = target_pk[position] if position < len(target_pk) else None
        if target_column is None:
            return None
        pairs.append(RawFkPair(src_column=item["from"], tgt_column=target_column))
    return pairs


def collect_sqlite(sa_engine: Engine, source_db: str) -> CatalogPayload:
    """한 SQLite 파일의 카탈로그를 ingest 페이로드로 / one SQLite file as an ingest payload."""
    objects: list[RawObject] = []
    columns: list[RawColumn] = []
    key_constraints: list[RawKeyConstraint] = []
    foreign_keys: list[RawForeignKey] = []
    view_definitions: list[RawViewDefinition] = []
    object_id_by_name: dict[str, int] = {}
    pk_by_name: dict[str, list[str]] = {}
    # (테이블명, FK그룹) — 다른 테이블의 object_id 배정이 끝난 뒤 대상 PK를 해석해야 한다
    pending_fks: list[tuple[str, list[dict[str, Any]]]] = []

    with sa_engine.connect() as conn:
        entries = conn.execute(text(_OBJECTS_SQL)).mappings().all()

        for object_id, entry in enumerate(entries, start=1):
            name = entry["name"]
            is_view = entry["type"] == "view"
            object_id_by_name[name] = object_id

            # 뷰는 COUNT(*)를 돌리지 않는다 — MSSQL/PG 수집기도 뷰 row_count는 의미 없어 비운다
            row_count = None if is_view else conn.execute(
                text(f"SELECT COUNT(*) FROM {quote_ident(name)}")).scalar_one()
            objects.append(RawObject(
                object_id=object_id, schema=SQLITE_SCHEMA, name=name,
                type="view" if is_view else "table", row_count=row_count,
            ))
            if is_view:
                view_definitions.append(
                    RawViewDefinition(object_id=object_id, definition=entry["sql"]))

            table_info = conn.execute(
                text(f"PRAGMA table_info({quote_ident(name)})")).mappings().all()
            pk_columns = _collect_primary_key(table_info)
            if pk_columns:
                pk_by_name[name] = pk_columns
                key_constraints.append(RawKeyConstraint(
                    # PK 이름도 조합이라 같은 폭 제한을 받는다 (FK와 같은 이유)
                    name=f"pk_{name}"[:_CONSTRAINT_NAME_LIMIT],
                    type="pk", object_id=object_id, columns=pk_columns))
            for column in table_info:
                columns.append(RawColumn(
                    # cid는 0-base — pg_collector의 attnum(1-base, MSSQL column_id와
                    # 같은 관례)에 맞춰 +1. 지금은 상대순서만 쓰이지만 "첫 컬럼" 의미를
                    # 소스 간에 맞춰 둔다.
                    object_id=object_id, name=column["name"], ordinal=column["cid"] + 1,
                    # 선언 타입이 비면 SQLite의 동적 타입 — BLOB으로 표기한다
                    data_type=column["type"] or "BLOB",
                    # SQLite는 길이 제약을 저장하지 않는다 (MSSQL의 varchar(max)와 같은 -1)
                    max_length=-1,
                    is_nullable=not column["notnull"], is_computed=False,
                ))

            if not is_view:
                fk_rows = conn.execute(
                    text(f"PRAGMA foreign_key_list({quote_ident(name)})")).mappings().all()
                for group in _group_foreign_keys([dict(row) for row in fk_rows]):
                    pending_fks.append((name, group))

    for src_name, group in pending_fks:
        tgt_name = group[0]["table"]
        tgt_object_id = object_id_by_name.get(tgt_name)
        if tgt_object_id is None:
            continue  # 카탈로그에 없는 테이블을 가리키는 FK는 버린다
        pairs = _resolve_fk_pairs(group, pk_by_name.get(tgt_name, []))
        if pairs is None:
            continue  # 해석 못 한 컬럼이 하나라도 있으면 FK 전체를 버린다
        foreign_keys.append(RawForeignKey(
            name=build_fk_name(src_name, tgt_name, group[0]["id"]),
            src_object_id=object_id_by_name[src_name],
            tgt_object_id=tgt_object_id, columns=pairs,
        ))

    return CatalogPayload(
        source_db=source_db, collected_at=datetime.now(UTC), objects=objects,
        columns=columns, key_constraints=key_constraints, foreign_keys=foreign_keys,
        view_definitions=view_definitions,
    )
