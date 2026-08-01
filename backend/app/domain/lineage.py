"""Set-level view lineage resolution — Phase 1 engine. / set 수준 뷰 lineage 재귀 해석 엔진.

카탈로그 DMV는 "뷰가 참조하는 컬럼 집합"만 주므로 결과는 전부 mapping_kind='set',
view_column='*'다. 출력 컬럼별 1:1 매핑은 Phase 2(sqlglot)가 승격한다.
Catalog DMVs only give the referenced-column set, so every row is set-level;
Phase 2 upgrades to per-output-column mappings.
"""

# (target_object_id, target_is_view, referenced_column) — resolved deps만 / resolved deps only
DepTuple = tuple[int, bool, str | None]


def resolve_lineage(
    deps_by_view: dict[int, list[DepTuple]], depth_limit: int = 10
) -> list[dict]:
    """Flatten every view to base tables with cycle/depth guards. / 순환·깊이 방어 포함 전개.

    - 순환: 경로 기반 감지 → flag='cycle', depth=0 행 하나로 대체
    - 깊이 초과: flag='depth_exceeded', depth=depth_limit 행 추가
    - 플래그는 상위 뷰로 전파된다 (cycle이 depth_exceeded보다 우선)
    """
    memo: dict[int, list[dict]] = {}
    on_path: set[int] = set()

    def visit(view_id: int) -> list[dict]:
        if view_id in memo:
            return memo[view_id]
        on_path.add(view_id)
        rows: list[dict] = []
        flags: set[str] = set()
        for target_id, target_is_view, column in deps_by_view.get(view_id, []):
            if not target_is_view:
                rows.append(
                    {"base_object_id": target_id, "base_column": column, "depth": 1, "flag": None}
                )
                continue
            if target_id in on_path:
                flags.add("cycle")
                continue
            for r in visit(target_id):
                if r["flag"]:
                    flags.add(r["flag"])
                elif r["depth"] + 1 > depth_limit:
                    flags.add("depth_exceeded")
                else:
                    rows.append({**r, "depth": r["depth"] + 1})
        if "cycle" in flags:
            rows.append({"base_object_id": None, "base_column": None, "depth": 0, "flag": "cycle"})
        elif "depth_exceeded" in flags:
            rows.append({
                "base_object_id": None, "base_column": None,
                "depth": depth_limit, "flag": "depth_exceeded",
            })
        on_path.discard(view_id)

        deduped, seen = [], set()
        for r in rows:
            key = (r["base_object_id"], r["base_column"], r["depth"], r["flag"])
            if key not in seen:
                seen.add(key)
                deduped.append(r)
        memo[view_id] = deduped
        return deduped

    out: list[dict] = []
    for view_id in sorted(deps_by_view):
        for r in visit(view_id):
            out.append({
                "view_object_id": view_id, "view_column": "*", "mapping_kind": "set", **r
            })
    return out
