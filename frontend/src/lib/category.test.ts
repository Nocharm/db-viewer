import { describe, expect, it } from "vitest";

import { getCategoryLockStates, resolveCategory, type SchemaCategoryMap } from "./category";

describe("resolveCategory", () => {
  it("uses the server mapping when the DB has one", () => {
    const mapping: SchemaCategoryMap = new Map([["SAPFI", "회계"], ["SAP", "회계"]]);
    expect(resolveCategory("SAP", mapping)).toBe("회계");
    // 같은 카테고리로 묶으면 두 DB가 한 그룹으로 합쳐진다 (일괄 이동의 결과)
    expect(resolveCategory("SAPFI", mapping)).toBe("회계");
  });

  it("falls back to the schema name so the list is never empty", () => {
    // 매핑 전에도 ATM·BCMS… 가 그대로 카테고리다
    expect(resolveCategory("ATM", new Map())).toBe("ATM");
    expect(resolveCategory("dbo", new Map([["SAP", "회계"]]))).toBe("dbo");
  });
});

describe("getCategoryLockStates", () => {
  const schemas = [
    { schema: "SAP", category: "회계" },
    { schema: "SAPFI", category: "회계" },
    { schema: "ATM", category: "ATM" },
    { schema: "HR", category: "인사" },
  ];

  it("raises both flags for a category whose DBs are mixed", () => {
    const states = getCategoryLockStates(schemas, new Set(["SAP"]));

    expect(states.get("회계")).toEqual({ hasAllowed: true, hasLocked: true }); // 혼재 → 둘 다
  });

  it("raises only one flag for uniformly allowed or locked categories", () => {
    const states = getCategoryLockStates(schemas, new Set(["SAP", "SAPFI"]));

    expect(states.get("회계")).toEqual({ hasAllowed: true, hasLocked: false });
    expect(states.get("ATM")).toEqual({ hasAllowed: false, hasLocked: true });
  });

  it("returns an empty map for an empty schema list", () => {
    expect(getCategoryLockStates([], new Set(["SAP"])).size).toBe(0);
  });
});
