"""FakeJoinValidator — fixture value sets, no real DB. / 픽스처 값 집합 기반 검증기 (계획 §4.3).

Fake만으로 스코어링·히스토리·confidence·미리보기까지 전부 완성한다.
Everything through preview must work on this alone.
"""

import json
from pathlib import Path

from app.domain.validation import ColumnRef, ContainmentResult, ValidationDataMissing


class FakeJoinValidator:
    def __init__(self, value_sets_path: Path):
        payload = json.loads(value_sets_path.read_text())
        self._sets: dict[tuple[str, str], dict] = {
            (entry["object"], entry["column"]): entry for entry in payload["columns"]
        }

    def _entry(self, ref: ColumnRef) -> dict:
        entry = self._sets.get((ref.object_qname, ref.column))
        if entry is None:
            raise ValidationDataMissing(ref)
        return entry

    def containment(self, src: ColumnRef, tgt: ColumnRef) -> ContainmentResult:
        src_entry, tgt_entry = self._entry(src), self._entry(tgt)
        src_vals, tgt_vals = set(src_entry["values"]), set(tgt_entry["values"])
        matched = len(src_vals & tgt_vals)
        return ContainmentResult(
            src_distinct=len(src_vals),
            matched=matched,
            containment=round(matched / len(src_vals), 4) if src_vals else 0.0,
            orphan_count=len(src_vals - tgt_vals),
            src_row_count=src_entry["row_count"],
            tgt_distinct=tgt_entry["distinct_count"],
            tgt_row_count=tgt_entry["row_count"],
        )

    def preview(self, src: ColumnRef, tgt: ColumnRef, limit: int) -> list[dict]:
        """조인 샘플 행 합성 — 요청 시점 온디맨드만 (캐시 금지, 계획 §3.5)."""
        src_entry, tgt_entry = self._entry(src), self._entry(tgt)
        matched = sorted(set(src_entry["values"]) & set(tgt_entry["values"]))
        return [
            {f"src.{src.column}": value, f"tgt.{tgt.column}": value}
            for value in matched[:limit]
        ]
