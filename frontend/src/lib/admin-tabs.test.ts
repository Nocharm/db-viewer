import { describe, expect, it } from "vitest";

import {
  ADMIN_TAB_IDS,
  buildAdminTabUrl,
  getNeighbourTab,
  parseAdminTab,
} from "./admin-tabs";

describe("parseAdminTab", () => {
  it("falls back to the sources tab for missing or unknown values", () => {
    expect(parseAdminTab(null)).toBe("sources");
    expect(parseAdminTab(undefined)).toBe("sources");
    expect(parseAdminTab("")).toBe("sources");
    expect(parseAdminTab("nope")).toBe("sources");
  });

  it("accepts every declared tab id", () => {
    for (const id of ADMIN_TAB_IDS) expect(parseAdminTab(id)).toBe(id);
  });
});

describe("buildAdminTabUrl", () => {
  it("drops the parameter for the default tab and keeps other params", () => {
    expect(buildAdminTabUrl("/admin", "?tab=users&x=1", "sources")).toBe("/admin?x=1");
    expect(buildAdminTabUrl("/admin", "", "sources")).toBe("/admin");
  });

  it("sets the parameter for a non-default tab", () => {
    expect(buildAdminTabUrl("/admin", "", "access")).toBe("/admin?tab=access");
    expect(buildAdminTabUrl("/admin", "?tab=ai", "users")).toBe("/admin?tab=users");
  });
});

describe("getNeighbourTab", () => {
  it("moves right and wraps at the end", () => {
    expect(getNeighbourTab("sources", 1)).toBe("access");
    expect(getNeighbourTab("users", 1)).toBe("audit");
    expect(getNeighbourTab("audit", 1)).toBe("sources");
  });

  it("moves left and wraps at the start", () => {
    expect(getNeighbourTab("access", -1)).toBe("sources");
    expect(getNeighbourTab("sources", -1)).toBe("audit");
  });
});
