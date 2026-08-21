import { describe, expect, it } from "vitest";

import {
  applyColumnOrder,
  buildCsv,
  buildPreviewSql,
  moveColumn,
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
    filters: [{ column: "EMP_NM", op: "contains" as const, value: "김'철수" }],
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

  it("renders the Postgres source with quoted identifiers, ILIKE and a trailing LIMIT", () => {
    // 업무 Postgres 탭은 방언이 다르다 — 복사해 그대로 실행되는 문장이어야 한다
    const sql = buildPreviewSql(
      { object: "public.orders", limit: 20, dialect: "pg" as const,
        filters: [{ column: "note", op: "contains" as const, value: "가" },
                  { column: "code", op: "eq" as const, value: "A" }] },
      ["id", 'we"ird'], { column: "id", dir: "asc" },
    );
    expect(sql).not.toContain("TOP");
    expect(sql).toContain('FROM "public"."orders"');
    expect(sql).toContain('"we""ird"'); // " 는 "" 로 / quote escape
    expect(sql).toContain(`WHERE "note"::text ILIKE '%가%'`);
    expect(sql).toContain(`AND upper("code"::text) = upper('A')`);
    expect(sql.trimEnd().endsWith("LIMIT 20;")).toBe(true);
  });

  it("omits WHERE and ORDER BY when absent", () => {
    const sql = buildPreviewSql({ ...STATE, filters: [] }, ["A"], null);
    expect(sql).not.toContain("WHERE");
    expect(sql).not.toContain("ORDER BY");
  });

  it("renders eq as equality, not LIKE", () => {
    const sql = buildPreviewSql(
      { ...STATE, filters: [{ column: "EMP_NM", op: "eq" as const, value: "김'철수" }] },
      ["EMP_NO"], null);
    expect(sql).toContain("WHERE [EMP_NM] = N'김''철수'");
    expect(sql).not.toContain("LIKE");
  });

  it("joins multiple conditions with AND in filter order", () => {
    const sql = buildPreviewSql({
      ...STATE,
      filters: [
        { column: "DEPT", op: "eq" as const, value: "10" },
        { column: "EMP_NM", op: "not_contains" as const, value: "퇴사" },
        { column: "PHONE", op: "is_null" as const, value: null },
      ],
    }, ["EMP_NO"], null);
    expect(sql).toContain(
      "WHERE [DEPT] = N'10'\n  AND [EMP_NM] NOT LIKE N'%퇴사%'\n  AND [PHONE] IS NULL");
  });

  it("renders exclusion and null ops", () => {
    const neq = buildPreviewSql(
      { ...STATE, filters: [{ column: "DEPT", op: "neq" as const, value: "10" }] }, ["A"], null);
    expect(neq).toContain("WHERE [DEPT] <> N'10'");
    const notNull = buildPreviewSql(
      { ...STATE, filters: [{ column: "DEPT", op: "not_null" as const, value: null }] },
      ["A"], null);
    expect(notNull).toContain("WHERE [DEPT] IS NOT NULL");
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

  it("classifies the AND / NOT LIKE / IS NULL keywords of advanced filters", () => {
    const tokens = tokenizeSql("WHERE [A] NOT LIKE N'%x%' AND [B] IS NULL");
    const keywords = tokens.filter((t) => t.type === "keyword").map((t) => t.text);
    expect(keywords).toEqual(["WHERE", "NOT", "LIKE", "AND", "IS", "NULL"]);
  });
});

describe("buildCsv", () => {
  it("quotes cells with commas/quotes and prepends a BOM", () => {
    const csv = buildCsv(["A", "B"], [{ A: 'say "hi", ok', B: 1 }]);
    expect(csv.startsWith("﻿")).toBe(true); // 엑셀 한글 인코딩 대응
    expect(csv).toContain('"say ""hi"", ok",1');
  });
});

describe("applyColumnOrder", () => {
  it("returns the original list when no order is saved", () => {
    const columns = ["a", "b", "c"];
    expect(applyColumnOrder(columns, [])).toBe(columns);
  });

  it("applies the saved order and appends unknown columns", () => {
    // 재조회로 새로 온 d는 뒤에, 사라진 x는 무시 / new columns append, stale ones drop
    expect(applyColumnOrder(["a", "b", "c", "d"], ["c", "x", "a"]))
      .toEqual(["c", "a", "b", "d"]);
  });
});

describe("moveColumn", () => {
  const columns = ["a", "b", "c", "d"];

  it("inserts before the target by default", () => {
    expect(moveColumn(columns, "d", "b", false)).toEqual(["a", "d", "b", "c"]);
  });

  it("inserts after the target — the only way to become last", () => {
    expect(moveColumn(columns, "a", "d", true)).toEqual(["b", "c", "d", "a"]);
  });

  it("keeps the list for self-drops or unknown targets", () => {
    expect(moveColumn(columns, "b", "b", false)).toEqual(columns);
    expect(moveColumn(columns, "b", "zzz", false)).toEqual(columns);
  });
});
