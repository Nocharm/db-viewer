"""PostgreSQL catalog collector. / PostgreSQL 카탈로그 수집기.

기존 ingest 계약(CatalogPayload)을 그대로 채운다 — 하류(검색·ERD·정책)가 엔진을 모른다.
시스템 스키마는 제외한다: 사용자가 볼 대상이 아니고 수천 개 객체로 목록을 오염시킨다.
"""

from datetime import UTC, datetime

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

_SCHEMA_FILTER = (
    "n.nspname NOT IN ('pg_catalog', 'information_schema') "
    "AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'"
)

_OBJECTS_SQL = f"""
SELECT c.oid AS oid, n.nspname AS schema_name, c.relname AS name,
       CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END AS type,
       -- 일반 뷰는 저장소가 없어 ANALYZE 자체가 거부된다("cannot analyze non-tables")
       -- — reltuples가 생성 시점 기본값(-1)에서 영영 못 벗어나 NULL로 명시한다. matview는
       -- 실제 heap을 갖는 storage라 ANALYZE(수동 또는 autovacuum)가 통하고, 분석되면
       -- 테이블과 동일하게 실제 카디널리티를 담는다(단 CREATE/REFRESH 직후 자체는 통계를
       -- 안 갱신한다 — 실측: 1000행으로 만들어도 ANALYZE 전엔 -1). 그래서 테이블과 같은
       -- reltuples 분기로 되돌린다 — "분석 전엔 NULL, 분석되면 실값"이라는 대우가 테이블과
       -- matview에 동일하게 적용되는 것이 이 값의 자연스러운 의미다.
       CASE WHEN c.relkind = 'v' THEN NULL
            WHEN c.reltuples < 0 THEN NULL
            ELSE c.reltuples::bigint END AS row_count,
       CASE WHEN c.relkind IN ('v', 'm')
            THEN pg_get_viewdef(c.oid, true) END AS definition
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm') AND {_SCHEMA_FILTER}
ORDER BY n.nspname, c.relname
"""

# max_length는 varchar/char의 선언 길이만 의미가 있다 — 나머지는 MSSQL 관례대로 -1
_COLUMNS_SQL = f"""
SELECT a.attrelid AS oid, a.attname AS name, a.attnum AS ordinal,
       format_type(a.atttypid, a.atttypmod) AS data_type,
       CASE WHEN t.typname IN ('varchar', 'bpchar') AND a.atttypmod > 4
            THEN a.atttypmod - 4 ELSE -1 END AS max_length,
       NOT a.attnotnull AS is_nullable,
       a.attgenerated <> '' AS is_computed
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_type t ON t.oid = a.atttypid
WHERE a.attnum > 0 AND NOT a.attisdropped
  AND c.relkind IN ('r', 'p', 'v', 'm') AND {_SCHEMA_FILTER}
ORDER BY a.attrelid, a.attnum
"""

# conkey 순서가 곧 컬럼 순서다 — WITH ORDINALITY 없이는 복합키 순서가 뒤집힌다
_KEYS_SQL = f"""
SELECT c.conname AS name,
       CASE c.contype WHEN 'p' THEN 'pk' ELSE 'uq' END AS type,
       c.conrelid AS oid,
       ARRAY(SELECT a.attname
             FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
             ORDER BY u.ord) AS columns
FROM pg_constraint c
JOIN pg_class r ON r.oid = c.conrelid
JOIN pg_namespace n ON n.oid = r.relnamespace
WHERE c.contype IN ('p', 'u') AND {_SCHEMA_FILTER}
"""

_FKS_SQL = f"""
SELECT c.conname AS name, c.conrelid AS src_oid, c.confrelid AS tgt_oid,
       ARRAY(SELECT a.attname
             FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
             ORDER BY u.ord) AS src_columns,
       ARRAY(SELECT a.attname
             FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = u.attnum
             ORDER BY u.ord) AS tgt_columns
FROM pg_constraint c
JOIN pg_class r ON r.oid = c.conrelid
JOIN pg_namespace n ON n.oid = r.relnamespace
WHERE c.contype = 'f' AND {_SCHEMA_FILTER}
"""


def map_oids_to_object_ids(oids: list[int]) -> dict[int, int]:
    """oid → 스냅샷 내 일련번호 / oid to a per-snapshot sequential id.

    pg_class.oid는 unsigned 32bit(max 4,294,967,295)라 objects.object_id(int4)를 넘길 수
    있다. 계약이 요구하는 건 스냅샷 안에서의 유일성뿐이므로 일련번호로 충분하다.
    """
    return {oid: index for index, oid in enumerate(oids, start=1)}


def collect_postgres(sa_engine: Engine, source_db: str) -> CatalogPayload:
    """한 PostgreSQL DB의 카탈로그를 ingest 페이로드로 / one PG database as an ingest payload."""
    with sa_engine.connect() as conn:
        object_rows = conn.execute(text(_OBJECTS_SQL)).mappings().all()
        oid_map = map_oids_to_object_ids([row["oid"] for row in object_rows])

        objects = [
            RawObject(object_id=oid_map[row["oid"]], schema=row["schema_name"],
                      name=row["name"], type=row["type"], row_count=row["row_count"])
            for row in object_rows
        ]
        view_definitions = [
            RawViewDefinition(object_id=oid_map[row["oid"]], definition=row["definition"])
            for row in object_rows if row["type"] == "view"
        ]
        columns = [
            RawColumn(object_id=oid_map[row["oid"]], name=row["name"],
                      ordinal=row["ordinal"], data_type=row["data_type"],
                      max_length=row["max_length"], is_nullable=row["is_nullable"],
                      is_computed=row["is_computed"])
            for row in conn.execute(text(_COLUMNS_SQL)).mappings()
            if row["oid"] in oid_map
        ]
        key_constraints = [
            RawKeyConstraint(name=row["name"], type=row["type"],
                             object_id=oid_map[row["oid"]], columns=list(row["columns"]))
            for row in conn.execute(text(_KEYS_SQL)).mappings()
            if row["oid"] in oid_map
        ]
        foreign_keys = [
            RawForeignKey(
                name=row["name"], src_object_id=oid_map[row["src_oid"]],
                tgt_object_id=oid_map[row["tgt_oid"]],
                columns=[RawFkPair(src_column=src, tgt_column=tgt)
                         for src, tgt in zip(row["src_columns"], row["tgt_columns"],
                                             strict=True)],
            )
            # 제외된 스키마를 가리키는 FK는 버린다 — 없는 객체를 참조하면 적재가 터진다
            for row in conn.execute(text(_FKS_SQL)).mappings()
            if row["src_oid"] in oid_map and row["tgt_oid"] in oid_map
        ]

    return CatalogPayload(
        source_db=source_db, collected_at=datetime.now(UTC), objects=objects,
        columns=columns, key_constraints=key_constraints, foreign_keys=foreign_keys,
        view_definitions=view_definitions,
    )
