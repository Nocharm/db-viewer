import { describe, expect, it } from "vitest";

import { buildPeriodRange, getActionCategory, isFailedEntry, summarizeCounts, toIsoRange } from "./audit";

describe("getActionCategory", () => {
  it("maps exposure, policy, ops and login actions", () => {
    expect(getActionCategory("table_preview")).toBe("exposure");
    expect(getActionCategory("preview_allow_add")).toBe("policy");
    expect(getActionCategory("collect_cancel")).toBe("ops");
    expect(getActionCategory("access_denied")).toBe("login");
    expect(getActionCategory("something_new")).toBe("ops");
  });
});

describe("isFailedEntry", () => {
  it("flags denied access and 'fail' details", () => {
    expect(isFailedEntry("access_denied", "park.min")).toBe(true);
    expect(isFailedEntry("ldap_login", "park.min fail")).toBe(true);
    expect(isFailedEntry("source_test", "svcc fail (OperationalError)")).toBe(true);
    expect(isFailedEntry("ldap_login", "park.min ok")).toBe(false);
    expect(isFailedEntry("table_preview", "dbo.FAILOVER_LOG (20 rows)")).toBe(false);
  });
});

describe("buildPeriodRange", () => {
  const now = new Date(2026, 8, 12, 15, 30);
  it("today starts at local midnight and has no upper bound", () => {
    expect(buildPeriodRange("today", now)).toEqual({ dateFrom: new Date(2026, 8, 12).toISOString() });
  });
  it("7d and 30d count back from today's midnight, today inclusive", () => {
    expect(buildPeriodRange("7d", now).dateFrom).toBe(new Date(2026, 8, 6).toISOString());
    expect(buildPeriodRange("30d", now).dateFrom).toBe(new Date(2026, 7, 14).toISOString());
  });
  it("all is empty", () => {
    expect(buildPeriodRange("all", now)).toEqual({});
  });
});

describe("toIsoRange", () => {
  it("makes the upper bound exclusive at the next midnight", () => {
    const range = toIsoRange("2026-09-10", "2026-09-11");
    expect(range.dateFrom).toBe(new Date(2026, 8, 10).toISOString());
    expect(range.dateTo).toBe(new Date(2026, 8, 12).toISOString());
  });
  it("leaves missing sides undefined", () => {
    expect(toIsoRange("", "")).toEqual({});
  });
});

describe("summarizeCounts", () => {
  it("sums by category", () => {
    expect(summarizeCounts({ table_preview: 3, value_probe: 1, whitelist_add: 2, login: 5 }))
      .toEqual({ total: 11, exposure: 4, policy: 2 });
  });
});
