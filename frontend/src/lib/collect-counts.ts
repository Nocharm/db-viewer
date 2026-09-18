/** 수집 잡 counts의 요약·분류 — 카드에는 핵심 몇 개, 모달에는 단계별 표로.
 * Collect-job counts: a few headline numbers for the cards, grouped rows for the modal. */

export type CountGroup = "catalog" | "deps" | "parse" | "other";

export interface CountEntry {
  key: string;
  value: number;
}

export interface CountGroupRows {
  group: CountGroup;
  items: CountEntry[];
}

// 백엔드 ingest가 남기는 키를 단계 순서대로 — 모르는 키는 "other"로 흘러 사라지지 않는다
// / keys in the order ingest reports them; unknown keys still surface under "other"
const GROUP_KEYS: Record<Exclude<CountGroup, "other">, readonly string[]> = {
  catalog: ["objects", "columns", "key_constraints", "foreign_keys"],
  deps: ["deps", "deps_unresolved", "deps_skipped", "unresolved_objects", "lineage_rows"],
  parse: [
    "views_parsed", "parse_ok", "parse_partial", "parse_unsupported",
    "column_lineage_rows", "view_joins",
  ],
};

/** 카드 한 줄에 실을 핵심 키 — ①은 크기(객체·컬럼·FK), ②는 파싱 성과(뷰·계보) */
export const STEP_SUMMARY_KEYS = {
  catalog: ["objects", "columns", "foreign_keys"],
  deps: ["views_parsed", "lineage_rows"],
} as const;

/** 청크 카운터는 진행 바가 담당 — 숫자 목록에서 뺀다 / chunk counters render as the bar */
export function isChunkCounter(key: string): boolean {
  return key.endsWith("_chunks_done") || key.endsWith("_chunks_total");
}

export function summarizeCounts(
  counts: Record<string, number>, keys: readonly string[],
): CountEntry[] {
  return keys
    .filter((key) => counts[key] !== undefined)
    .map((key) => ({ key, value: counts[key] }));
}

export function groupCounts(counts: Record<string, number>): CountGroupRows[] {
  const known = new Set(Object.values(GROUP_KEYS).flat());
  const groups: CountGroupRows[] = (Object.keys(GROUP_KEYS) as (keyof typeof GROUP_KEYS)[])
    .map((group) => ({ group, items: summarizeCounts(counts, GROUP_KEYS[group]) }));
  const other = Object.entries(counts)
    .filter(([key]) => !known.has(key) && !isChunkCounter(key))
    .map(([key, value]) => ({ key, value }));
  groups.push({ group: "other", items: other });
  return groups.filter((g) => g.items.length > 0);
}
