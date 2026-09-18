import { describe, expect, it } from "vitest";

import { getNavItems } from "./AppHeader";

describe("getNavItems", () => {
  it("keeps every link open and bare for the default (MSSQL) source", () => {
    const items = getNavItems(null, null);
    expect(items.map((i) => i.path)).toEqual(["/", "/verify", "/erd", "/trace", "/parsing"]);
    expect(items.every((i) => !i.locked)).toBe(true);
    expect(items.every((i) => i.href === i.path)).toBe(true);
  });

  it("carries the selected source in every href so navigation keeps the selection", () => {
    const items = getNavItems("mssql", 1);
    expect(items.find((i) => i.path === "/erd")?.href).toBe("/erd?source=1");
    expect(items.find((i) => i.path === "/")?.href).toBe("/?source=1");
  });

  it("locks the MSSQL-only entries for another engine instead of dropping them", () => {
    const items = getNavItems("postgres", 2);
    expect(items.map((i) => i.path)).toEqual(["/", "/verify", "/erd", "/trace", "/parsing"]);
    expect(items.filter((i) => i.locked).map((i) => i.path)).toEqual(["/verify", "/parsing"]);
    expect(items.find((i) => i.path === "/trace")?.href).toBe("/trace?source=2");
  });

  it("treats an omitted engine (pages without source tracking) as open", () => {
    expect(getNavItems(undefined, undefined).every((i) => !i.locked)).toBe(true);
  });
});
