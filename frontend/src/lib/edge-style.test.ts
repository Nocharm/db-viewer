import { describe, expect, it } from "vitest";

import { confidenceOpacity, getEdgeVisual } from "./edge-style";

describe("getEdgeVisual", () => {
  it("maps kinds to design-app.md tokens and dash patterns", () => {
    expect(getEdgeVisual("fk")).toMatchObject({
      stroke: "var(--rel-confirmed)", strokeDasharray: undefined, opacity: 1,
    });
    expect(getEdgeVisual("inferred").strokeDasharray).toBe("8 4");
    expect(getEdgeVisual("ai_suggested")).toMatchObject({
      stroke: "var(--rel-ai)", strokeDasharray: "3 3",
    });
    expect(getEdgeVisual("view_lineage")).toMatchObject({
      stroke: "var(--rel-lineage)", strokeDasharray: "1.5 4",
    });
    expect(getEdgeVisual("unresolved").stroke).toBe("var(--rel-unresolved)");
  });

  it("uses 2px strokes everywhere", () => {
    for (const kind of ["fk", "inferred", "ai_suggested", "view_lineage", "unresolved"] as const) {
      expect(getEdgeVisual(kind).strokeWidth).toBe(2);
    }
  });

  it("applies stepped confidence opacity only to inferred edges", () => {
    expect(getEdgeVisual("inferred", 0.999).opacity).toBe(1.0);
    expect(getEdgeVisual("inferred", 0.96).opacity).toBe(0.7);
    expect(getEdgeVisual("inferred", 0.5).opacity).toBe(0.45);
    expect(getEdgeVisual("fk", 0.5).opacity).toBe(1.0);
  });
});

describe("confidenceOpacity", () => {
  it("is a 3-step scale, never below 0.45", () => {
    expect(confidenceOpacity(1.0)).toBe(1.0);
    expect(confidenceOpacity(0.97)).toBe(0.7);
    expect(confidenceOpacity(0)).toBe(0.45);
  });
});
