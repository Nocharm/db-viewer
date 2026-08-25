"""Preview SQL builder for direct sources. / 직결 소스 미리보기 SQL 빌더.

여기가 보안 경계다. **식별자는 카탈로그에 실재하는 이름만** 통과하고, 값은 전부 바인드
파라미터로 나간다. 사용자 입력이 식별자 자리에 들어가는 경로는 존재하지 않는다.

PostgreSQL과 SQLite는 이 용도에서 문법이 같다("인용, LIMIT, CAST AS TEXT, LIKE ESCAPE).
SQLAlchemy text()의 named 파라미터를 쓰면 paramstyle 차이도 없어 빌더가 하나로 족하다.
"""

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
