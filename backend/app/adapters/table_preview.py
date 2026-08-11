"""Table preview rows without a real DB. / 실DB 없는 테이블 미리보기 합성 (fixture 모드).

의미: 미리보기·재검색은 항상 **원본 소스에 새 질의**다 — 받은 20행을 클라이언트에서
거르는 게 아니라, 조건이 소스 쿼리(WHERE)로 내려간다. fixture는 그 의미를 흉내내기
위해 큰 풀을 생성 후 거른다. live 구현체는 연결 단계(정지점 18)에서 조건 포함
`SELECT TOP 20`으로 교체 — 실행 경로(pyodbc 직접 vs n8n 경유)는 사용자 방침에 따라
그 시점에 확정한다(계획 §2는 pyodbc 직접을 명시하나 n8n 선호 의견 있음).
"""

import json
from pathlib import Path


class FakeTablePreview:
    """값 집합이 있으면 실제 값, 없으면 타입 관례 기반 샘플 / value sets first, typed samples otherwise."""

    def __init__(self, value_sets_path: Path):
        self._sets: dict[tuple[str, str], list] = {}
        if value_sets_path.exists():
            payload = json.loads(value_sets_path.read_text())
            self._sets = {
                (entry["object"], entry["column"]): entry["values"]
                for entry in payload["columns"]
            }

    def _sample(self, column_name: str, data_type: str, row_index: int) -> object:
        if data_type in ("int", "bigint"):
            return 1000 + row_index
        if data_type == "decimal":
            return round((row_index + 1) * 12.5, 2)
        if data_type in ("datetime2",):
            return f"2026-07-{(row_index % 28) + 1:02d}T09:{row_index:02d}:00"
        if data_type == "date":
            return f"2026-07-{(row_index % 28) + 1:02d}"
        if data_type == "char" and column_name.endswith("_YMD"):
            return f"202607{(row_index % 28) + 1:02d}"
        if data_type == "char" and column_name.endswith("_YM"):
            return "202607"
        if data_type == "char":
            return "Y" if row_index % 2 == 0 else "N"
        if column_name.endswith("_NM") or data_type == "nvarchar":
            return f"샘플{column_name.split('_')[0].title()}{row_index + 1}"
        return f"{column_name.replace('_', '')[:6]}{row_index + 1:03d}"

    def rows(
        self, qname: str, columns: list[dict], limit: int,
        filters: list[dict] | None = None,
    ) -> list[dict]:
        """조건이 있으면 큰 풀에서 생성 후 전부(AND) 걸러 limit 적용 — live WHERE 대응.

        문자 비교 조건은 대소문자 무시 — MSSQL 기본 collation이 case-insensitive라
        live와 결이 같다. is_null은 진짜 None만 — 빈 문자열은 NULL이 아니다.
        With filters we synthesize a larger pool then AND-filter, mirroring a live
        WHERE clause; string ops are case-insensitive like the default collation.
        """
        filters = filters or []
        pool = limit if not filters else max(limit * 10, 200)
        out: list[dict] = []
        for row_index in range(pool):
            row = {}
            for column in columns:
                values = self._sets.get((qname, column["name"]))
                if values:
                    row[column["name"]] = values[row_index % len(values)]
                else:
                    row[column["name"]] = self._sample(
                        column["name"], column["data_type"], row_index
                    )
            if all(_matches_cond(row, cond) for cond in filters):
                out.append(row)
            if len(out) >= limit:
                break
        return out


def _matches_cond(row: dict, cond: dict) -> bool:
    """조건 하나 평가 — op 의미는 W2 템플릿의 WHERE 절과 1:1 / one condition, W2-parity."""
    cell = row.get(cond["column"])
    op = cond.get("op", "contains")
    if op == "is_null":
        return cell is None
    if op == "not_null":
        return cell is not None
    needle = (cond.get("value") or "").upper()
    text = "" if cell is None else str(cell).upper()
    if op == "eq":
        return text == needle
    if op == "neq":
        return text != needle
    if op == "not_contains":
        return needle not in text
    return needle in text
