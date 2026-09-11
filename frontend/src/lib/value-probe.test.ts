import { describe, expect, it } from "vitest";

import type { SchemaCategoryItem, ValueProbeHit } from "./api";
import {
  buildPreviewHref, describeSkippedView, findButtonLabel, formatMatchCount, parseFiltersParam,
  remainingSchemas, selectableSchemas, shouldKeepPolling, validateProbeRequest,
} from "./value-probe";

const hit: ValueProbeHit = {
  object_id: 42, qname: "SAP.T_ORD", object_type: "table", column: "ORD_NO",
  match_count: 1, count_capped: false, matched_variant: "ORD-0910-001",
  exposed_by_views: [], derived_from: null,
};

describe("validateProbeRequest", () => {
  const ok = {
    sourceId: 1, schemas: ["SAP"], value: "x", hint: "",
    mode: "normalized" as const, includeRelatedViews: false,
  };

  it("accepts a complete form", () => {
    expect(validateProbeRequest(ok)).toBeNull();
  });

  it("requires at least one schema and a non-blank value", () => {
    expect(validateProbeRequest({ ...ok, schemas: [] })).toBe("trace.err.noSchema");
    expect(validateProbeRequest({ ...ok, value: "   " })).toBe("trace.err.noValue");
  });

  it("caps the value length at 100 like the preview filter", () => {
    expect(validateProbeRequest({ ...ok, value: "x".repeat(101) })).toBe("trace.err.valueTooLong");
  });
});

describe("selectableSchemas", () => {
  const items: SchemaCategoryItem[] = [
    { schema: "SAP", category: "영업", mapped: true, object_count: 10 },
    { schema: "MAP", category: "MAP", mapped: false, object_count: 3 },
    { schema: "STG", category: "STG", mapped: false, object_count: 2 },
  ];

  it("keeps only allowlisted schemas that are not hidden", () => {
    // 허용 목록은 대소문자 그대로, 숨김은 소문자로 내려온다
    const picked = selectableSchemas(items, new Set(["SAP", "STG"]), new Set(["stg"]));
    expect(picked.map((s) => s.schema)).toEqual(["SAP"]);
  });
});

describe("buildPreviewHref", () => {
  it("opens the object with an eq filter on the stored form of the value", () => {
    const href = buildPreviewHref(hit, 3);
    expect(href.startsWith("/?table=42&preview=1&filters=")).toBe(true);
    expect(href.endsWith("&source=3")).toBe(true);
    const encoded = new URL(href, "http://x").searchParams.get("filters");
    expect(JSON.parse(encoded ?? "")).toEqual([{ column: "ORD_NO", op: "eq", value: "ORD-0910-001" }]);
  });

  it("omits the source for the default source", () => {
    expect(buildPreviewHref(hit, null)).not.toContain("source=");
  });
});

describe("parseFiltersParam", () => {
  it("returns validated conditions", () => {
    const raw = JSON.stringify([{ column: "A", op: "eq", value: "1" }]);
    expect(parseFiltersParam(raw)).toEqual([{ column: "A", op: "eq", value: "1" }]);
  });

  it("returns null for missing, malformed or unknown-op input", () => {
    expect(parseFiltersParam(null)).toBeNull();
    expect(parseFiltersParam("{")).toBeNull();
    expect(parseFiltersParam(JSON.stringify([{ column: "A", op: "drop", value: "1" }]))).toBeNull();
    expect(parseFiltersParam(JSON.stringify([]))).toBeNull();
  });

  it("caps at five conditions like the backend", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ column: `C${i}`, op: "eq", value: "v" }));
    expect(parseFiltersParam(JSON.stringify(six))).toBeNull();
  });
});

describe("shouldKeepPolling", () => {
  it("polls only while queued or running", () => {
    expect(shouldKeepPolling("queued")).toBe(true);
    expect(shouldKeepPolling("running")).toBe(true);
    expect(shouldKeepPolling("done")).toBe(false);
    expect(shouldKeepPolling("cancelled")).toBe(false);
  });
});

describe("remainingSchemas", () => {
  it("lists allowlisted schemas that were not searched yet", () => {
    expect(remainingSchemas(["SAP", "ATM", "BCMS"], ["SAP"])).toEqual(["ATM", "BCMS"]);
  });
});

describe("formatMatchCount", () => {
  it("renders the cap with a plus and null as a check mark key", () => {
    expect(formatMatchCount({ ...hit, match_count: 1000, count_capped: true })).toBe("1000+");
    expect(formatMatchCount({ ...hit, match_count: 7 })).toBe("7");
    expect(formatMatchCount({ ...hit, match_count: null })).toBeNull();
  });
});

describe("describeSkippedView", () => {
  it("names the view and the policy reason", () => {
    expect(describeSkippedView({ qname: "SAP.V_X", schema: "SAP", reason: "not_allowed" }, "ko"))
      .toBe("SAP.V_X — 허용 목록 밖");
    expect(describeSkippedView({ qname: "HR.V_Y", schema: "HR", reason: "hidden" }, "en"))
      .toBe("HR.V_Y — hidden schema");
  });
});

describe("findButtonLabel", () => {
  it("shows progress while running and stop on hover", () => {
    expect(findButtonLabel({ running: false, hovering: false, done: 0, total: 0 })).toBe("find");
    expect(findButtonLabel({ running: true, hovering: false, done: 12, total: 422 })).toBe("progress");
    expect(findButtonLabel({ running: true, hovering: true, done: 12, total: 422 })).toBe("stop");
  });
});
