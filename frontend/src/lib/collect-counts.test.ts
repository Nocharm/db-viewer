import { describe, expect, it } from "vitest";

import { groupCounts, summarizeCounts } from "./collect-counts";

// 실서버 full 수집 한 건의 counts 모양 그대로 / shape of one real full-collection job
const FULL = {
  objects: 495, columns: 9432, key_constraints: 409, foreign_keys: 176,
  deps: 417, deps_unresolved: 6, unresolved_objects: 3, lineage_rows: 428,
  views_parsed: 82, parse_ok: 79, parse_partial: 1, parse_unsupported: 2,
  column_lineage_rows: 408, view_joins: 18,
  catalog_chunks_done: 5, catalog_chunks_total: 5,
};

describe("summarizeCounts", () => {
  it("picks the requested keys in order and skips the ones the job does not carry", () => {
    expect(summarizeCounts(FULL, ["objects", "columns", "foreign_keys"])).toEqual([
      { key: "objects", value: 495 }, { key: "columns", value: 9432 },
      { key: "foreign_keys", value: 176 },
    ]);
    // direct 소스 잡은 파싱 항목이 아예 없다 — 빈 pill을 만들지 않는다
    expect(summarizeCounts({ objects: 7, foreign_keys: 3 }, ["views_parsed", "lineage_rows"]))
      .toEqual([]);
  });
});

describe("groupCounts", () => {
  it("sorts every count into catalog / deps / parse and drops the chunk counters", () => {
    const groups = groupCounts(FULL);
    expect(groups.map((g) => g.group)).toEqual(["catalog", "deps", "parse"]);
    expect(groups[0].items.map((i) => i.key))
      .toEqual(["objects", "columns", "key_constraints", "foreign_keys"]);
    expect(groups[2].items.map((i) => i.key)).toEqual([
      "views_parsed", "parse_ok", "parse_partial", "parse_unsupported",
      "column_lineage_rows", "view_joins",
    ]);
    const all = groups.flatMap((g) => g.items.map((i) => i.key));
    expect(all.some((k) => k.includes("chunks"))).toBe(false);
  });

  it("omits empty groups and keeps unknown keys visible under 'other'", () => {
    const groups = groupCounts({ objects: 7, foreign_keys: 3, brand_new_metric: 1 });
    expect(groups.map((g) => g.group)).toEqual(["catalog", "other"]);
    expect(groups[1].items).toEqual([{ key: "brand_new_metric", value: 1 }]);
  });

  it("returns nothing for a job without counts", () => {
    expect(groupCounts({})).toEqual([]);
  });
});
