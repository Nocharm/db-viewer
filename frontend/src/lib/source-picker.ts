/** 소스 선택기의 순수 로직 — 기본 선택 해석과 키보드 이동. 화면 없이 테스트한다.
 * Pure helpers for the source picker: default resolution and wrap-around keyboard stepping. */

import type { SourceOption } from "@/lib/api";

/** value가 null(사내 MSSQL 기본)이거나 목록에 없으면 첫 소스를 고른 것으로 본다 —
 * 예전 `<select>`의 `value ?? sources[0]` 규칙 그대로 / null or unknown falls back to the first */
export function resolveSelectedSource(
  sources: SourceOption[], value: number | null,
): SourceOption | null {
  if (sources.length === 0) return null;
  return sources.find((source) => source.id === value) ?? sources[0];
}

/** ↑/↓ 이동 — 끝에서는 반대편으로 감는다. 목록이 비면 -1 / wraps at both ends */
export function stepActiveIndex(current: number, delta: -1 | 1, length: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return (current + delta + length) % length;
}
