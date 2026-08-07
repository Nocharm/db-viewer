import { describe, expect, it } from "vitest";

import { getMatchRank, rankSearchResults } from "./search-rank";

describe("getMatchRank", () => {
  it("orders exact > prefix > contains > subsequence", () => {
    expect(getMatchRank("HR_EMP", "HR_EMP")).toBe(0);
    expect(getMatchRank("HR_", "HR_EMP")).toBe(1);
    expect(getMatchRank("EMP", "HR_EMP")).toBe(2);
    expect(getMatchRank("HREMP", "HR_EMP")).toBe(3); // 순서 유사 — 문자가 순서대로 등장
  });

  it("is case-insensitive and rejects out-of-order letters", () => {
    expect(getMatchRank("hr_emp", "HR_EMP")).toBe(0);
    expect(getMatchRank("PME", "HR_EMP")).toBe(Infinity); // 역순은 비매칭
    expect(getMatchRank("HREMPX", "HR_EMP")).toBe(Infinity);
  });
});

describe("rankSearchResults", () => {
  const items = ["ORD_SO_HDR", "HR_EMP", "HR_EMP_HIST", "EMP_NO_MAP", "HREMP_LEGACY"];

  it("sorts by tier then name, dropping non-matches", () => {
    // HR_EMP는 HREMP_LEGACY와 비매칭 — '_' 뒤에 M이 다시 안 나옴 (순서 유사의 경계)
    expect(rankSearchResults("HR_EMP", items, (s) => s)).toEqual([
      "HR_EMP",        // 0 정확
      "HR_EMP_HIST",   // 1 접두어
    ]);
    expect(rankSearchResults("HREMP", items, (s) => s)).toEqual([
      "HREMP_LEGACY",  // 1 접두어
      "HR_EMP",        // 3 순서 유사
      "HR_EMP_HIST",   // 3 순서 유사 — 동단계 이름순
    ]);
  });

  it("keeps everything on an empty query", () => {
    expect(rankSearchResults("  ", items, (s) => s)).toEqual(items);
  });
});
