"""Preview SQL builder for direct sources. / 직결 소스 미리보기 SQL 빌더.

여기가 보안 경계다. **식별자는 카탈로그에 실재하는 이름만** 통과하고, 값은 전부 바인드
파라미터로 나간다. 사용자 입력이 식별자 자리에 들어가는 경로는 존재하지 않는다.

PostgreSQL과 SQLite는 이 용도에서 문법이 같다("인용, LIMIT, CAST AS TEXT, LIKE ESCAPE).
SQLAlchemy text()의 named 파라미터를 쓰면 paramstyle 차이도 없어 빌더가 하나로 족하다.
"""

import uuid
from datetime import date, datetime
from decimal import Decimal

# 대소문자 무시 비교 — MSSQL 기본 collation이 CI라 화면 의미를 그쪽에 맞춘다
_CI = 'UPPER(CAST({col} AS TEXT))'
_LIKE_ESCAPE = "\\"


class UnknownIdentifier(ValueError):
    """카탈로그에 없는 스키마·테이블·컬럼 — 질의를 만들지 않는다."""


def quote_ident(name: str) -> str:
    """식별자를 인용하고 내부 인용부호를 escape한다."""
    return '"' + name.replace('"', '""') + '"'


def escape_like(value: str) -> str:
    """LIKE 메타문자를 리터럴로 — 사용자가 넣은 %는 와일드카드가 아니다."""
    return (value.replace(_LIKE_ESCAPE, _LIKE_ESCAPE * 2)
            .replace("%", _LIKE_ESCAPE + "%")
            .replace("_", _LIKE_ESCAPE + "_"))


def _build_condition(cond: dict, index: int) -> tuple[str, dict[str, str]]:
    """단일 필터 조건을 SQL 절로 변환한다."""
    col = quote_ident(cond["column"])
    op = cond.get("op", "contains")
    if op == "is_null":
        return f"{col} IS NULL", {}
    if op == "not_null":
        return f"{col} IS NOT NULL", {}

    key = f"p{index}"
    holder = f":{key}"
    ci = _CI.format(col=col)
    raw = cond.get("value")
    value = "" if raw is None else str(raw)
    if op == "eq":
        return f"{ci} = UPPER({holder})", {key: value}
    if op == "neq":
        # 부정 연산은 NULL 행도 포함한다 — fixture 구현이 NULL을 빈 문자열로 본다
        return f"({col} IS NULL OR {ci} <> UPPER({holder}))", {key: value}
    like = f"{ci} LIKE UPPER({holder}) ESCAPE '{_LIKE_ESCAPE}'"
    needle = f"%{escape_like(value)}%"
    if op == "contains":
        return like, {key: needle}
    if op == "not_contains":
        return f"({col} IS NULL OR NOT ({like}))", {key: needle}
    raise UnknownIdentifier(f"unsupported filter op: {op}")


def build_preview_sql(
    schema: str, table: str, column_names: list[str], filters: list[dict],
    limit: int, allowed_columns: set[str],
) -> tuple[str, dict[str, str]]:
    """미리보기 SELECT 문과 바인드 파라미터 / the preview SELECT and its bound params."""
    for name in column_names:
        if name not in allowed_columns:
            raise UnknownIdentifier(f"column not in the catalog: {name}")

    select_list = ", ".join(quote_ident(name) for name in column_names)
    sql = f"SELECT {select_list} FROM {quote_ident(schema)}.{quote_ident(table)}"

    params: dict[str, str] = {}
    clauses: list[str] = []
    for index, cond in enumerate(filters):
        if cond["column"] not in allowed_columns:
            raise UnknownIdentifier(f"column not in the catalog: {cond['column']}")
        clause, bound = _build_condition(cond, index)
        clauses.append(clause)
        params.update(bound)
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    return f"{sql} LIMIT {int(limit)}", params


def _bind_probe_value(family: str, value: str | int, dialect: str) -> object:
    """패밀리에 맞는 파이썬 타입으로 — PG는 date=text·uuid=text 비교를 거부하고,
    sqlite3는 Decimal을 바인드하지 못한다."""
    if family == "int":
        return int(value)
    if family == "decimal":
        return float(value) if dialect == "sqlite" else Decimal(str(value))
    if family == "date":
        text = str(value)
        return datetime.fromisoformat(text) if len(text) > 10 else date.fromisoformat(text)
    if family == "guid":
        return uuid.UUID(str(value))
    return str(value)


def _build_probe_clause(column: dict, index: int, dialect: str) -> tuple[str, dict[str, object]]:
    """컬럼 하나의 조건 — 컬럼 쪽엔 함수를 씌우지 않는다(인덱스 보존)."""
    col = quote_ident(column["name"])
    values = list(column.get("values") or [])
    if not values:
        raise UnknownIdentifier(f"probe column without values: {column['name']}")
    if column.get("op") == "contains":
        key = f"p{index}_0"
        return (f"{col} LIKE :{key} ESCAPE '{_LIKE_ESCAPE}'",
                {key: f"%{escape_like(str(values[0]))}%"})
    params: dict[str, object] = {}
    holders: list[str] = []
    for position, value in enumerate(values):
        key = f"p{index}_{position}"
        params[key] = _bind_probe_value(column["family"], value, dialect)
        holders.append(f":{key}")
    return f"{col} IN ({', '.join(holders)})", params


def build_probe_sql(
    schema: str, table: str, columns: list[dict], allowed_columns: set[str], dialect: str,
) -> tuple[str, dict[str, object]]:
    """객체 하나의 프로브 — 후보 컬럼 전부를 OR로 묶은 SELECT … LIMIT 1."""
    if not columns:
        raise UnknownIdentifier("probe needs at least one column")
    for column in columns:
        if column["name"] not in allowed_columns:
            raise UnknownIdentifier(f"column not in the catalog: {column['name']}")
    select_list = ", ".join(quote_ident(column["name"]) for column in columns)
    clauses: list[str] = []
    params: dict[str, object] = {}
    for index, column in enumerate(columns):
        clause, bound = _build_probe_clause(column, index, dialect)
        clauses.append(clause)
        params.update(bound)
    sql = (f"SELECT {select_list} FROM {quote_ident(schema)}.{quote_ident(table)} "
           f"WHERE {' OR '.join(clauses)} LIMIT 1")
    return sql, params


def build_count_sql(
    schema: str, table: str, column: dict, allowed_columns: set[str], cap: int, dialect: str,
) -> tuple[str, dict[str, object]]:
    """맞은 컬럼의 건수 — 내부 LIMIT cap+1로 상한을 건다(cap+1이면 '1000+')."""
    if column["name"] not in allowed_columns:
        raise UnknownIdentifier(f"column not in the catalog: {column['name']}")
    clause, params = _build_probe_clause(column, 0, dialect)
    table_ref = f"{quote_ident(schema)}.{quote_ident(table)}"
    sql = (f"SELECT COUNT(*) AS n FROM (SELECT 1 AS x FROM {table_ref} "
           f"WHERE {clause} LIMIT {int(cap) + 1}) q")
    return sql, params
