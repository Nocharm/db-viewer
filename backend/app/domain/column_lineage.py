"""Column-precision lineage composition — Phase 2. / 파싱 결과를 base table까지 조립.

파서는 뷰 1단만 본다 — 중첩 뷰는 부모의 컬럼 lineage를 재귀 조립한다.
카탈로그(set-level) 행은 건드리지 않고 direct/derived 행을 "보강"만 한다 (계획 §2.2).
The parser sees one hop; nesting composes recursively. Catalog rows are
never overwritten — parsed rows only augment.
"""

from app.domain.view_parsing import ParsedView, SourceRef

# (base_qname, base_column, depth, kind)
ResolvedSource = tuple[str, str, int, str]


def build_column_lineage(
    parsed_by_view: dict[str, ParsedView],
    object_types: dict[str, str],  # qname → "table" | "view"
    table_columns: dict[str, list[str]],  # table qname → ordered columns (star 확장용)
    depth_limit: int = 10,
) -> dict[str, dict[str, list[ResolvedSource]]]:
    """view qname → {output column → resolved base sources}."""
    memo: dict[str, dict[str, list[ResolvedSource]]] = {}
    visiting: set[str] = set()

    def combine_kind(parent_kind: str, own_kind: str) -> str:
        return "derived" if "derived" in (parent_kind, own_kind) else "direct"

    def resolve_source(src: SourceRef, column: str, kind: str) -> list[ResolvedSource]:
        if src.database:
            return []  # 크로스 DB는 카탈로그 밖 / cross-DB lives outside the catalog
        qname = src.qname
        obj_type = object_types.get(qname)
        if obj_type == "table":
            return [(qname, column, 1, kind)] if column in table_columns.get(qname, []) else []
        if obj_type == "view":
            return [
                (base, base_col, depth + 1, combine_kind(k, kind))
                for base, base_col, depth, k in resolve_view(qname).get(column, [])
                if depth + 1 <= depth_limit
            ]
        return []  # 카탈로그에 없는 객체 (드랍된 테이블 등) / not in catalog

    def resolve_view(qname: str) -> dict[str, list[ResolvedSource]]:
        if qname in memo:
            return memo[qname]
        if qname in visiting:
            return {}  # 순환은 Phase 1이 이미 플래그 / cycles already flagged by phase 1
        visiting.add(qname)
        out: dict[str, list[ResolvedSource]] = {}
        parsed = parsed_by_view.get(qname)
        if parsed is not None and parsed.status in ("ok", "partial"):
            if parsed.select_star_source is not None:
                star = parsed.select_star_source
                if object_types.get(star.qname) == "table":
                    for col in table_columns.get(star.qname, []):
                        out[col] = [(star.qname, col, 1, "direct")]
                elif object_types.get(star.qname) == "view":
                    for col, rows in resolve_view(star.qname).items():
                        out[col] = [
                            (b, bc, d + 1, k) for b, bc, d, k in rows if d + 1 <= depth_limit
                        ]
            for output in parsed.outputs:
                rows: list[ResolvedSource] = []
                for src, col in output.sources:
                    rows.extend(resolve_source(src, col, output.kind))
                if rows:
                    out.setdefault(output.name, []).extend(rows)
        visiting.discard(qname)
        memo[qname] = out
        return out

    for qname in sorted(parsed_by_view):
        resolve_view(qname)
    return {q: rows for q, rows in memo.items() if rows}


def flatten_rows(
    resolved: dict[str, dict[str, list[ResolvedSource]]],
) -> list[dict]:
    """중복 제거된 평탄 행 — 같은 매핑은 최소 depth 채택 / dedupe, keep min depth."""
    best: dict[tuple, dict] = {}
    for view, columns in resolved.items():
        for col, sources in columns.items():
            for base, base_col, depth, kind in sources:
                key = (view, col, base, base_col, kind)
                if key not in best or depth < best[key]["depth"]:
                    best[key] = {
                        "view": view, "view_column": col, "base": base,
                        "base_column": base_col, "depth": depth, "mapping_kind": kind,
                    }
    return sorted(
        best.values(),
        key=lambda r: (r["view"], r["view_column"], r["base"], r["base_column"]),
    )
