import { describe, expect, it } from "vitest";

import {
  buildCsv,
  buildPreviewSql,
  countUniqueValues,
  sortRows,
  tokenizeSql,
} from "./preview-utils";

const ROWS = [
  { QTY: 20, NM: "b" },
  { QTY: 3, NM: "a" },
  { QTY: null, NM: "c" },
  { QTY: 100, NM: "a" },
];

describe("sortRows", () => {
  it("sorts numerically when values are numbers, nulls last, without mutating", () => {
    const sorted = sortRows(ROWS, { column: "QTY", dir: "asc" });
    expect(sorted.map((r) => r.QTY)).toEqual([3, 20, 100, null]); // 문자열 정렬이면 100<20
    expect(ROWS[0].QTY).toBe(20); // 원본 불변
    const desc = sortRows(ROWS, { column: "NM", dir: "desc" });
    expect(desc[0].NM).toBe("c");
  });
});

describe("countUniqueValues", () => {
  it("counts by value, descending", () => {
    expect(countUniqueValues(ROWS, "NM")).toEqual([
      { value: "a", count: 2 },
      { value: "b", count: 1 },
      { value: "c", count: 1 },
    ]);
  });
});

describe("buildPreviewSql", () => {
  const STATE = {
    object: "dbo.HR_EMP",
    limit: 50,
    filter: { column: "EMP_NM", value: "김'철수" },
  };

  it("renders the current state as T-SQL with escaping", () => {
    const sql = buildPreviewSql(STATE, ["EMP_NO", "we]ird"], { column: "EMP_NO", dir: "desc" });
    expect(sql).toContain("SELECT TOP 50");
    expect(sql).toContain("[EMP_NO]");
    expect(sql).toContain("[we]]ird]"); // ] 는 ]] 로 / bracket escape
    expect(sql).toContain("FROM [dbo].[HR_EMP]");
    expect(sql).toContain("WHERE [EMP_NM] LIKE N'%김''철수%'"); // ' 는 '' 로
    expect(sql).toContain("ORDER BY [EMP_NO] DESC");
  });

  it("omits WHERE and ORDER BY when absent", () => {
    const sql = buildPreviewSql({ ...STATE, filter: null }, ["A"], null);
    expect(sql).not.toContain("WHERE");
    expect(sql).not.toContain("ORDER BY");
  });
});

describe("tokenizeSql", () => {
  it("classifies keywords, identifiers, strings and numbers", () => {
    const tokens = tokenizeSql("SELECT TOP 20 [EMP_NO] FROM [dbo].[HR] WHERE [A] LIKE N'%x''y%'");
    const byType = (type: string) =>
      tokens.filter((t) => t.type === type).map((t) => t.text);
    expect(byType("keyword")).toEqual(["SELECT", "TOP", "FROM", "WHERE", "LIKE"]);
    expect(byType("number")).toEqual(["20"]);
    expect(byType("identifier")).toEqual(["[EMP_NO]", "[dbo]", "[HR]", "[A]"]);
    expect(byType("string")).toEqual(["N'%x''y%'"]); // '' 이스케이프째로 한 토큰
    // 재조립하면 원문과 동일 / tokens reassemble to the original text
    expect(tokens.map((t) => t.text).join("")).toContain("FROM [dbo].[HR]");
  });
});

describe("buildCsv", () => {
  it("quotes cells with commas/quotes and prepends a BOM", () => {
    const csv = buildCsv(["A", "B"], [{ A: 'say "hi", ok', B: 1 }]);
    expect(csv.startsWith("﻿")).toBe(true); // 엑셀 한글 인코딩 대응
    expect(csv).toContain('"say ""hi"", ok",1');
  });
});
