# backend/app/adapters/value_probe.py
"""Value probing without a real DB. / 실DB 없는 값 추적 (fixture 모드).

value_sets.json의 컬럼별 값 집합을 그대로 뒤진다. 집합이 없는 컬럼은 항상 미스 —
합성 행을 만들어 히트를 꾸며내지 않는다(FakeTablePreview와 다른 점: 여기서 가짜 히트는
"찾았다"는 거짓이 된다).
"""

import json
from pathlib import Path

from app.domain.value_probe import ProbeColumn, match_cell


class FakeValueProber:
    """N8nValueProber·DirectValueProber와 같은 시그니처 / same shape as the live probers."""

    def __init__(self, value_sets_path: Path):
        self._sets: dict[tuple[str, str], list] = {}
        if value_sets_path.exists():
            payload = json.loads(value_sets_path.read_text())
            self._sets = {
                (entry["object"], entry["column"]): entry["values"]
                for entry in payload["columns"]
            }

    def probe(self, schema: str, name: str, columns: list[ProbeColumn]) -> list[dict]:
        qname = f"{schema}.{name}"
        row: dict = {}
        hit = False
        for column in columns:
            values = self._sets.get((qname, column.name), [])
            found = next((v for v in values if match_cell(v, column) is not None), None)
            row[column.name] = found
            hit = hit or found is not None
        return [row] if hit else []

    def count(self, schema: str, name: str, column: ProbeColumn, cap: int) -> int:
        values = self._sets.get((f"{schema}.{name}", column.name), [])
        matched = sum(1 for v in values if match_cell(v, column) is not None)
        return min(matched, cap + 1)
