"""Read-only access to the secondary business Postgres. / 업무 Postgres 읽기 전용 직결.

MSSQL 원천은 n8n W2 경유(자격증명이 n8n에만 있다)지만, 이 Postgres는 앱 서버 옆
컨테이너로 떠 있는 별도 업무 DB라 대응하는 워크플로가 없다 — psycopg 직결이 유일한
경로다. 대신 연결 자체를 읽기 전용으로 못박고(`default_transaction_read_only`),
문장 타임아웃을 걸어 잘못된 질의가 소스를 오래 잡지 못하게 한다.
Direct psycopg reads, forced read-only at the connection level.
"""

import logging
from contextlib import contextmanager
from typing import Iterator

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict
from psycopg.rows import dict_row

logger = logging.getLogger(__name__)

# 시스템 스키마는 목록에서 제외 — 업무 테이블만 보여준다 / system schemas are never listed
_SYSTEM_SCHEMAS = ("pg_catalog", "information_schema")


class PgSourceError(RuntimeError):
    """연결·질의 실패 — 원인을 화면까지 그대로 전달한다 / surfaced to the UI as-is."""


def describe_dsn(dsn: str) -> dict[str, str]:
    """자격증명을 뺀 접속 표시용 정보 / connection info for display, credentials stripped."""
    try:
        info = conninfo_to_dict(dsn)
    except psycopg.Error as e:
        raise PgSourceError(f"invalid PG_SOURCE_DSN: {e}") from e
    return {
        "host": str(info.get("host", "")),
        "port": str(info.get("port", "")),
        "database": str(info.get("dbname", "")),
        "user": str(info.get("user", "")),
    }


@contextmanager
def _connect(dsn: str, timeout: int) -> Iterator[psycopg.Connection]:
    # statement_timeout은 ms — 연결 타임아웃과 같은 상한을 문장에도 건다
    options = f"-c default_transaction_read_only=on -c statement_timeout={timeout * 1000}"
    try:
        with psycopg.connect(dsn, connect_timeout=timeout, options=options,
                             row_factory=dict_row) as conn:
            yield conn
    except psycopg.Error as e:
        logger.warning("pg_source query failed", extra={"error": str(e)})
        raise PgSourceError(str(e).strip()) from e


def list_tables(dsn: str, timeout: int) -> list[dict]:
    """업무 스키마의 테이블·뷰 목록 + 행 수 추정 / tables and views with an estimated count.

    reltuples는 ANALYZE 기준 추정치다(-1 = 분석된 적 없음 → None). 정확한 COUNT(*)는
    큰 테이블에서 소스를 오래 잡아 목록 조회에는 쓰지 않는다.
    """
    query = f"""
        SELECT n.nspname AS schema,
               c.relname AS name,
               CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END AS type,
               CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS row_estimate
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm')
          AND n.nspname NOT IN {_SYSTEM_SCHEMAS}
          AND n.nspname NOT LIKE 'pg\\_toast%'
        ORDER BY n.nspname, c.relname
    """
    with _connect(dsn, timeout) as conn, conn.cursor() as cur:
        cur.execute(query)
        return [dict(row) for row in cur.fetchall()]


def list_columns(dsn: str, timeout: int, schema: str, table: str) -> list[dict]:
    """컬럼 이름·타입 (정의 순서) / column names and types in ordinal order."""
    query = """
        SELECT column_name AS name, data_type AS data_type
        FROM information_schema.columns
        WHERE table_schema = %s AND table_name = %s
        ORDER BY ordinal_position
    """
    with _connect(dsn, timeout) as conn, conn.cursor() as cur:
        cur.execute(query, (schema, table))
        return [dict(row) for row in cur.fetchall()]


def build_cond(cond: dict) -> tuple[sql.Composed, list[str]]:
    """조건 하나를 WHERE 조각 + 바인딩 값으로 / one condition as SQL and its parameters.

    의미는 MSSQL 경로와 맞춘다 — 문자 비교는 대소문자 무시(기본 collation이 CI),
    NULL은 비교에서 빠진다(NOT LIKE도 NULL을 통과시키지 않는다). 값은 항상 바인딩이고
    식별자만 Identifier로 인용한다.
    """
    column = sql.Identifier(cond["column"])
    op = cond.get("op", "contains")
    if op == "is_null":
        return sql.SQL("{} IS NULL").format(column), []
    if op == "not_null":
        return sql.SQL("{} IS NOT NULL").format(column), []
    value = cond.get("value") or ""
    if op == "eq":
        return sql.SQL("upper({}::text) = upper(%s)").format(column), [value]
    if op == "neq":
        return sql.SQL("upper({}::text) <> upper(%s)").format(column), [value]
    if op == "not_contains":
        return sql.SQL("{}::text NOT ILIKE %s").format(column), [f"%{value}%"]
    return sql.SQL("{}::text ILIKE %s").format(column), [f"%{value}%"]


def build_rows_query(
    schema: str, table: str, columns: list[str], limit: int, filters: list[dict],
) -> tuple[sql.Composed, list]:
    """SELECT … WHERE … LIMIT — 식별자는 인용, 값은 전부 바인딩 / identifiers quoted, values bound."""
    fragments = [build_cond(cond) for cond in filters]
    params: list = [value for _, values in fragments for value in values]
    query = sql.SQL("SELECT {cols} FROM {table}").format(
        cols=sql.SQL(", ").join(sql.Identifier(c) for c in columns),
        table=sql.Identifier(schema, table),
    )
    if fragments:
        query = query + sql.SQL(" WHERE ") + sql.SQL(" AND ").join(f for f, _ in fragments)
    return query + sql.SQL(" LIMIT %s"), [*params, limit]


def fetch_rows(
    dsn: str, timeout: int, schema: str, table: str, columns: list[str],
    limit: int, filters: list[dict],
) -> list[dict]:
    """미리보기 행 — 조건은 소스 WHERE로 내려간다 / rows with the conditions pushed to the source."""
    query, params = build_rows_query(schema, table, columns, limit, filters)
    with _connect(dsn, timeout) as conn, conn.cursor() as cur:
        cur.execute(query, params)
        return [dict(row) for row in cur.fetchall()]
