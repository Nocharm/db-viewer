import { describe, expect, it } from "vitest";

import { getPgTabId } from "./pg-tabs";

describe("getPgTabId", () => {
  it("keeps ids unique across sources so tabs never overwrite each other", () => {
    // 두 연결의 같은 순번 — 겹치면 탭 하나가 다른 DB의 행으로 덮인다
    expect(getPgTabId("bizdb", 0)).not.toBe(getPgTabId("hrdb", 0));
    expect(getPgTabId("bizdb", 3)).not.toBe(getPgTabId("hrdb", 3));
  });

  it("is stable and ordered within one source", () => {
    expect(getPgTabId("bizdb", 2)).toBe(getPgTabId("bizdb", 2));
    expect(getPgTabId("bizdb", 3) - getPgTabId("bizdb", 2)).toBe(1);
  });

  it("separates sources by more than any realistic table count", () => {
    const gap = Math.abs(getPgTabId("bizdb", 0) - getPgTabId("hrdb", 0));
    expect(gap).toBeGreaterThanOrEqual(100_000);
  });
});
