"""T-SQL view definition parsing via sqlglot — Phase 2. / sqlglot 기반 뷰 DDL 파싱.

파싱 실패는 격리한다 — 어떤 뷰도 파이프라인을 중단시키지 않는다 (계획 §2.2).
Failures are isolated; no single view may break the pipeline.
"""

from dataclasses import dataclass, field

import sqlglot
from sqlglot import exp
from sqlglot.errors import SqlglotError


@dataclass(frozen=True)
class SourceRef:
    """3부 이름 참조 — database가 있으면 크로스 DB / three-part name; database set = cross-DB."""

    database: str | None
    schema: str | None
    name: str

    @property
    def qname(self) -> str:
        return f"{self.schema or 'dbo'}.{self.name}"


@dataclass
class OutputColumn:
    name: str
    kind: str  # direct | derived
    sources: list[tuple[SourceRef, str]] = field(default_factory=list)


@dataclass
class ParsedJoin:
    left: tuple[SourceRef, str]
    right: tuple[SourceRef, str]
    join_type: str


@dataclass
class ParsedView:
    status: str  # ok | partial | unsupported | parse_failed
    error: str | None = None
    select_star_source: SourceRef | None = None
    outputs: list[OutputColumn] = field(default_factory=list)
    joins: list[ParsedJoin] = field(default_factory=list)
    cross_databases: list[str] = field(default_factory=list)


def strip_sql_comments(sql: str) -> str:
    """주석 제거 전처리 — 주석 속 옛 쿼리가 조인·lineage로 오인되는 것을 원천 차단.

    파서(sqlglot)도 주석을 무시하지만 버전·엣지 케이스에 의존하지 않도록 앞단에서
    확정적으로 제거한다. T-SQL 규칙 준수: 블록 주석 중첩(/* /* */ */) 허용,
    문자열 리터럴('' 이스케이프)·[대괄호]·"따옴표" 식별자 안의 주석 기호는 보존.
    Strips -- and nested block comments while respecting string literals and
    quoted identifiers, so commented-out SQL can never be parsed as live query.
    """
    out: list[str] = []
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if ch == "-" and nxt == "-":
            # 라인 주석 — 줄바꿈은 남겨 토큰 경계 유지 / keep the newline as a separator
            while i < n and sql[i] != "\n":
                i += 1
            continue
        if ch == "/" and nxt == "*":
            depth, i = 1, i + 2
            while i < n and depth > 0:
                pair = sql[i:i + 2]
                if pair == "/*":
                    depth, i = depth + 1, i + 2
                elif pair == "*/":
                    depth, i = depth - 1, i + 2
                else:
                    i += 1
            out.append(" ")  # 주석이 토큰 사이 공백이던 자리 보존 / preserve separation
            continue
        if ch == "'":
            end = i + 1
            while end < n:
                if sql[end] == "'":
                    if end + 1 < n and sql[end + 1] == "'":
                        end += 2  # '' 이스케이프 / escaped quote
                        continue
                    break
                end += 1
            out.append(sql[i:min(end + 1, n)])
            i = end + 1
            continue
        if ch in ("[", '"'):
            closer = "]" if ch == "[" else '"'
            end = sql.find(closer, i + 1)
            end = n - 1 if end == -1 else end
            out.append(sql[i:end + 1])
            i = end + 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def parse_view(definition: str) -> ParsedView:
    """Parse one CREATE VIEW statement. / CREATE VIEW 1건 파싱 — 예외는 상태로 격리."""
    try:
        tree = sqlglot.parse_one(strip_sql_comments(definition), read="tsql")
    except (SqlglotError, RecursionError) as e:
        return ParsedView(status="parse_failed", error=str(e)[:400])
    if isinstance(tree, exp.Command):
        # sqlglot은 미지원 구문을 예외 대신 Command로 폴백한다 / silent fallback, not an exception
        return ParsedView(status="parse_failed", error="unsupported syntax (Command fallback)")

    select = tree.expression if isinstance(tree, exp.Create) else tree
    if isinstance(select, exp.Subquery):
        select = select.this
    if not isinstance(select, exp.Select):
        return ParsedView(
            status="unsupported",
            error=f"unsupported top-level expression: {type(select).__name__}",
        )

    # alias → 소스. None = 해석 불가 소스(서브쿼리·APPLY) / None marks unresolvable sources
    tables: dict[str, SourceRef | None] = {}
    unsupported_reason: str | None = None

    def register_source(node: exp.Expression | None) -> None:
        nonlocal unsupported_reason
        if node is None:
            return
        if node.args.get("pivots"):
            # PIVOT 출력 컬럼은 물리 컬럼 매핑이 없다 (Table·Subquery 양쪽에 붙는다)
            # PIVOT outputs have no physical mapping; attaches to Table or Subquery
            unsupported_reason = "PIVOT"
        if isinstance(node, exp.Table) and not isinstance(node.this, exp.Func):
            tables[node.alias_or_name] = SourceRef(
                node.catalog or None, node.db or None, node.name
            )
        else:
            alias = node.alias_or_name if isinstance(node, (exp.Subquery, exp.Lateral)) else None
            tables[alias or f"__anon_{len(tables)}"] = None

    from_clause = select.args.get("from")
    register_source(from_clause.this if from_clause else None)
    for join in select.args.get("joins") or []:
        register_source(join.this)

    def resolve_column(col: exp.Column) -> tuple[SourceRef, str] | None:
        alias = col.table
        if alias:
            ref = tables.get(alias)
        elif len(tables) == 1:
            ref = next(iter(tables.values()))
        else:
            ref = None  # 무자격 + 다중 소스 = 모호 / unqualified over multiple sources
        return (ref, col.name) if ref is not None else None

    joins: list[ParsedJoin] = []
    for join in select.args.get("joins") or []:
        condition = join.args.get("on")
        if condition is None:
            continue
        join_type = (join.side or join.kind or "inner").lower()
        for eq in condition.find_all(exp.EQ):
            if isinstance(eq.left, exp.Column) and isinstance(eq.right, exp.Column):
                left, right = resolve_column(eq.left), resolve_column(eq.right)
                if left and right:
                    joins.append(ParsedJoin(left, right, join_type))

    outputs: list[OutputColumn] = []
    star_source: SourceRef | None = None
    has_unresolved = False
    for proj in select.expressions:
        if isinstance(proj, exp.Star) or (
            isinstance(proj, exp.Column) and isinstance(proj.this, exp.Star)
        ):
            resolved = [t for t in tables.values() if t is not None]
            if len(tables) == 1 and len(resolved) == 1:
                star_source = resolved[0]
            else:
                has_unresolved = True  # 다중 소스 * 는 컬럼 매핑 불가 / multi-source star
            continue
        name = proj.alias_or_name
        inner = proj.this if isinstance(proj, exp.Alias) else proj
        if isinstance(inner, exp.Column):
            source = resolve_column(inner)
            if source:
                outputs.append(OutputColumn(name, "direct", [source]))
            else:
                has_unresolved = True
        else:
            referenced = list(inner.find_all(exp.Column))
            sources = [s for s in (resolve_column(c) for c in referenced) if s]
            if sources:
                outputs.append(OutputColumn(name, "derived", sources))
            elif referenced:
                has_unresolved = True
            # 컬럼 없는 상수식은 lineage 없음이 정상 / constant expressions carry no lineage

    if unsupported_reason:
        status, error = "unsupported", unsupported_reason
    elif has_unresolved:
        status, error = "partial", None
    else:
        status, error = "ok", None

    cross_databases = sorted({
        ref.database
        for ref in tables.values()
        if ref is not None and ref.database
    })
    return ParsedView(
        status=status, error=error, select_star_source=star_source,
        outputs=outputs, joins=joins, cross_databases=cross_databases,
    )
