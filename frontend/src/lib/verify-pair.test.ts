import { describe, expect, it } from "vitest";

import {
  applyManualSelection, buildManualPair, filterPendingRelations, isSamePair,
  toManualSelection,
} from "./verify-pair";

const srcColumns = [
  { id: 1, name: "order_no", data_type: "varchar", is_pk: false, is_join_key: true },
  { id: 2, name: "created_at", data_type: "datetime", is_pk: false, is_join_key: false },
];

const tgtColumns = [
  { id: 11, name: "order_no", data_type: "varchar", is_pk: true, is_join_key: true },
];

describe("isSamePair", () => {
  it("accepts a result whose pair is still selected", () => {
    const requested = { src_column_id: 1, tgt_column_id: 11 };
    const current = { src_column_id: 1, tgt_column_id: 11 };

    expect(isSamePair(requested, current)).toBe(true);
  });

  // 페어 A 검증 중 B로 넘어간 뒤 A의 응답이 도착하는 경합 — 이걸 놓치면 검증한 적 없는
  // 페어에 확정 버튼이 열린다 / the race the guard exists for
  it("rejects a result that arrives after the pair changed", () => {
    const requested = { src_column_id: 1, tgt_column_id: 11 };

    expect(isSamePair(requested, { src_column_id: 2, tgt_column_id: 11 })).toBe(false);
    expect(isSamePair(requested, { src_column_id: 1, tgt_column_id: 12 })).toBe(false);
  });

  it("rejects a result that arrives after the pair was cleared", () => {
    expect(isSamePair({ src_column_id: 1, tgt_column_id: 11 }, null)).toBe(false);
    expect(isSamePair(null, { src_column_id: 1, tgt_column_id: 11 })).toBe(false);
    expect(isSamePair(null, null)).toBe(false);
  });
});

describe("toManualSelection", () => {
  it("seeds both selects from the selected pair", () => {
    expect(toManualSelection({ src_column_id: 1, tgt_column_id: 11 }))
      .toEqual({ srcColumnId: 1, tgtColumnId: 11 });
  });

  it("starts empty when nothing is selected", () => {
    expect(toManualSelection(null)).toEqual({ srcColumnId: null, tgtColumnId: null });
  });
});

describe("applyManualSelection", () => {
  it("keeps the other side while one side changes", () => {
    const half = applyManualSelection({ srcColumnId: null, tgtColumnId: null }, "src", 1);
    expect(half).toEqual({ srcColumnId: 1, tgtColumnId: null });

    const full = applyManualSelection(half, "tgt", 11);
    expect(full).toEqual({ srcColumnId: 1, tgtColumnId: 11 });
  });

  it("clears one side without touching the other", () => {
    const cleared = applyManualSelection({ srcColumnId: 1, tgtColumnId: 11 }, "tgt", null);

    expect(cleared).toEqual({ srcColumnId: 1, tgtColumnId: null });
  });
});

describe("buildManualPair", () => {
  it("builds a pair once both sides are picked", () => {
    const pair = buildManualPair({ srcColumnId: 1, tgtColumnId: 11 }, srcColumns, tgtColumns);

    expect(pair).toEqual({
      src_column_id: 1, src_column: "order_no", src_data_type: "varchar",
      tgt_column_id: 11, tgt_column: "order_no", tgt_data_type: "varchar",
      tgt_is_pk: true, score: 0, signals: {},
    });
  });

  it("stays null while only one side is picked", () => {
    expect(buildManualPair({ srcColumnId: 1, tgtColumnId: null }, srcColumns, tgtColumns))
      .toBeNull();
    expect(buildManualPair({ srcColumnId: null, tgtColumnId: 11 }, srcColumns, tgtColumns))
      .toBeNull();
  });

  // 컬럼 목록이 아직 안 왔거나 다른 테이블의 id가 남아 있는 경우 / stale or unloaded columns
  it("stays null when the picked column is not in the loaded list", () => {
    expect(buildManualPair({ srcColumnId: 99, tgtColumnId: 11 }, srcColumns, tgtColumns))
      .toBeNull();
  });
});

describe("filterPendingRelations", () => {
  const items = [
    { src_object: "dbo.A", tgt_object: "dbo.B" },
    { src_object: "dbo.C", tgt_object: "dbo.A" },
    { src_object: "dbo.C", tgt_object: "dbo.D" },
  ];

  it("returns the original reference when nothing is picked", () => {
    expect(filterPendingRelations(items, [])).toBe(items);
  });

  it("matches a picked table on either end", () => {
    // dbo.A가 출발(1번)이든 대상(2번)이든 관련 항목이다
    expect(filterPendingRelations(items, ["dbo.A"]))
      .toEqual([items[0], items[1]]);
  });

  it("requires every picked table to be involved", () => {
    expect(filterPendingRelations(items, ["dbo.C", "dbo.A"])).toEqual([items[1]]);
    expect(filterPendingRelations(items, ["dbo.A", "dbo.D"])).toEqual([]);
  });
});
