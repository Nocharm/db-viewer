"""Table preview rows without a real DB. / 실DB 없는 테이블 미리보기 합성 (fixture 모드).

live 전환 시 이 어댑터만 pyodbc `SELECT TOP 20`으로 교체한다 (계획 §2 — 온디맨드는
n8n 경유 금지, FastAPI 직접 실행).
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
        filter_column: str | None = None, filter_value: str | None = None,
    ) -> list[dict]:
        """필터가 있으면 큰 풀에서 생성 후 걸러 limit 적용 — live의 WHERE 절 대응.

        With a filter we synthesize a larger pool then filter, mirroring what a
        live WHERE clause would return.
        """
        pool = limit if not (filter_column and filter_value) else max(limit * 10, 200)
        needle = (filter_value or "").upper()
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
            if filter_column and needle:
                if needle not in str(row.get(filter_column, "")).upper():
                    continue
            out.append(row)
            if len(out) >= limit:
                break
        return out
