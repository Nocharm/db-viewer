import { describe, expect, it } from "vitest";

import { isChosungQuery, matchTable, toChosung } from "./search";

const target = {
  name: "TB_QC_SAMPLE_RSLT",
  categoryLabel: "품질",
  columns: ["SAMPLE_NO", "ITEM_CD", "JUDGE_CD", "TESTER_EMP_NO"],
};

describe("toChosung", () => {
  it("extracts initial consonants from Korean syllables", () => {
    expect(toChosung("품질")).toBe("ㅍㅈ");
    expect(toChosung("생산")).toBe("ㅅㅅ");
    expect(toChosung("ABC품질1")).toBe("ABCㅍㅈ1");
  });
});

describe("isChosungQuery", () => {
  it("detects pure chosung strings", () => {
    expect(isChosungQuery("ㅍㅈ")).toBe(true);
    expect(isChosungQuery("품질")).toBe(false);
    expect(isChosungQuery("")).toBe(false);
  });
});

describe("matchTable", () => {
  it("matches the table name with a highlight range", () => {
    const match = matchTable("sample", target);
    expect(match.matched).toBe(true);
    expect(match.nameRange).toEqual([6, 12]);
  });

  it("falls back to column names and reports the hit", () => {
    const match = matchTable("JUDGE", target);
    expect(match.matched).toBe(true);
    expect(match.nameRange).toBeNull();
    expect(match.matchedColumn).toBe("JUDGE_CD");
    expect(match.columnRange).toEqual([0, 5]);
  });

  it("matches the Korean category label directly and by chosung", () => {
    expect(matchTable("품질", target).matched).toBe(true);
    expect(matchTable("ㅍㅈ", target).matched).toBe(true);
    expect(matchTable("ㅅㅅ", target).matched).toBe(false);
  });

  it("rejects non-matching queries", () => {
    expect(matchTable("ZZZZ", target).matched).toBe(false);
  });

  it("empty query matches everything without highlights", () => {
    const match = matchTable("  ", target);
    expect(match.matched).toBe(true);
    expect(match.nameRange).toBeNull();
  });
});

describe("matchTable rank", () => {
  it("ranks name matches by exact/prefix/contains", () => {
    expect(matchTable("TB_QC_SAMPLE_RSLT", target).rank).toBe(0);
    expect(matchTable("TB_QC", target).rank).toBe(1);
    expect(matchTable("sample", target).rank).toBe(2);
  });

  it("falls back to order-similar name matching without a highlight range", () => {
    // "TBRSLT" — TB_QC_SAMPLE_RSLT에 순서대로만 등장, 연속 부분문자열은 아님
    const match = matchTable("TBRSLT", target);
    expect(match.matched).toBe(true);
    expect(match.rank).toBe(3);
    expect(match.nameRange).toBeNull();
  });

  it("ranks column matches at 4", () => {
    expect(matchTable("JUDGE", target).rank).toBe(4);
  });

  it("ranks category matches (plain and chosung) at 5", () => {
    expect(matchTable("품질", target).rank).toBe(5);
    expect(matchTable("ㅍㅈ", target).rank).toBe(5);
  });

  it("ranks an empty query at 0", () => {
    expect(matchTable("  ", target).rank).toBe(0);
  });

  it("ranks non-matching queries at Infinity", () => {
    expect(matchTable("ZZZZ", target).rank).toBe(Infinity);
  });
});
