import { describe, expect, it } from "vitest";

import { confidenceOpacity, getCardinalityEnds, getEdgeGrade, getEdgeVisual } from "./edge-style";

describe("getEdgeGrade", () => {
  it("collapses five kinds into three grades", () => {
    expect(getEdgeGrade("fk")).toBe("confirmed");
    expect(getEdgeGrade("confirmed")).toBe("confirmed");
    expect(getEdgeGrade("inferred")).toBe("inferred");
    expect(getEdgeGrade("ai_suggested")).toBe("inferred");
    expect(getEdgeGrade("unresolved")).toBe("unresolved");
  });

  it("keeps view_lineage on its own axis — it is provenance, not a relation", () => {
    expect(getEdgeGrade("view_lineage")).toBe("lineage");
  });
});

describe("getEdgeVisual", () => {
  it("draws confirmed grades solid and inferred grades dashed", () => {
    expect(getEdgeVisual("fk")).toMatchObject({
      stroke: "var(--rel-confirmed)", strokeDasharray: undefined, opacity: 1,
    });
    expect(getEdgeVisual("confirmed").strokeDasharray).toBeUndefined();
    expect(getEdgeVisual("inferred").strokeDasharray).toBe("8 4");
    // AI 제안도 추정 등급 — 같은 파선으로 합류 / ai_suggested joins the inferred grade
    expect(getEdgeVisual("ai_suggested").strokeDasharray).toBe("8 4");
    expect(getEdgeVisual("ai_suggested").stroke).toBe("var(--rel-inferred)");
  });

  it("draws unresolved faint and dotted", () => {
    expect(getEdgeVisual("unresolved")).toMatchObject({
      stroke: "var(--rel-unresolved)", strokeDasharray: "2 4",
    });
    expect(getEdgeVisual("unresolved").opacity).toBeLessThan(1);
  });

  it("keeps view_lineage grey and faint", () => {
    expect(getEdgeVisual("view_lineage").stroke).toBe("var(--rel-lineage)");
    expect(getEdgeVisual("view_lineage").strokeDasharray).toBe("1.5 4");
  });

  it("uses 2px strokes everywhere", () => {
    for (const kind of
      ["fk", "confirmed", "inferred", "ai_suggested", "view_lineage", "unresolved"] as const) {
      expect(getEdgeVisual(kind).strokeWidth).toBe(2);
    }
  });

  it("applies stepped confidence opacity only inside the inferred grade", () => {
    expect(getEdgeVisual("inferred", 0.999).opacity).toBe(1.0);
    expect(getEdgeVisual("inferred", 0.96).opacity).toBe(0.7);
    expect(getEdgeVisual("inferred", 0.5).opacity).toBe(0.45);
    expect(getEdgeVisual("ai_suggested", 0.5).opacity).toBe(0.45);
    // 확정 등급은 confidence로 흐려지지 않는다 / confirmed never fades
    expect(getEdgeVisual("fk", 0.5).opacity).toBe(1.0);
    expect(getEdgeVisual("confirmed", 0.5).opacity).toBe(1.0);
  });
});

describe("confidenceOpacity", () => {
  it("steps at 0.99 and 0.95", () => {
    expect(confidenceOpacity(1.0)).toBe(1.0);
    expect(confidenceOpacity(0.95)).toBe(0.7);
    expect(confidenceOpacity(0.94)).toBe(0.45);
  });
});

describe("getCardinalityEnds", () => {
  it("maps the backend's actual output to crow's-foot ends in src:tgt order", () => {
    // backend/app/domain/validation.py::ContainmentResult.cardinality only ever emits
    // these two strings — src(child) is the "many" side, tgt(unique target) is "one".
    // Pinning the real producer's output here (not an assumed "1:N") is what would
    // have caught the direction bug: "1:N" reads the same as "N:1" to a human skimming
    // a test, but src:tgt order makes them opposite crow's-foot placements.
    expect(getCardinalityEnds("N:1")).toEqual({ source: "many", target: "one" });
    expect(getCardinalityEnds("N:M")).toEqual({ source: "many", target: "many" });
  });

  it("parses src:tgt strings generically, independent of what the backend emits today", () => {
    expect(getCardinalityEnds("1:N")).toEqual({ source: "one", target: "many" });
    expect(getCardinalityEnds("1:1")).toEqual({ source: "one", target: "one" });
  });

  it("draws nothing when cardinality is unknown — absence means unverified", () => {
    expect(getCardinalityEnds(null)).toEqual({ source: null, target: null });
    expect(getCardinalityEnds(undefined)).toEqual({ source: null, target: null });
    expect(getCardinalityEnds("")).toEqual({ source: null, target: null });
    expect(getCardinalityEnds("garbage")).toEqual({ source: null, target: null });
  });
});
