import { describe, expect, it } from "vitest";

import { getJoinVerdict, getWorstVerdictIndex, type JoinVerdict } from "./join-verdict";
import type { ContainmentResponse } from "./types";

function makeResult(overrides: Partial<ContainmentResponse> = {}): ContainmentResponse {
  return {
    src: "ATM.T_ORDER.ORDER_ID", tgt: "ATM.T_ORDER_LOG.ORDER_ID",
    containment: 1.0, matched: 100, src_distinct: 100, orphan_count: 0,
    cardinality: "1:N", confidence: 1.0, pattern: "stable_confirmed",
    observations: 3, observed_at: "2026-08-05T00:00:00Z",
    ...overrides,
  };
}

describe("getJoinVerdict", () => {
  it("rejects low-cardinality columns before looking at anything else", () => {
    const verdict = getJoinVerdict(makeResult(), "low_distinct");
    expect(verdict.level).toBe("danger");
    expect(verdict.symptom).toContain("값 종류");
  });

  it("flags N:M as row explosion even at full containment", () => {
    // N:M이 containment 100%보다 우선 — 짝은 맞아도 행이 폭증한다
    const verdict = getJoinVerdict(makeResult({ cardinality: "N:M" }), null);
    expect(verdict.level).toBe("danger");
    expect(verdict.symptom).toContain("폭증");
  });

  it("calls a full-containment join safe", () => {
    const verdict = getJoinVerdict(makeResult(), null);
    expect(verdict.level).toBe("safe");
    expect(verdict.remedy).toBeNull();
  });

  it("prescribes LEFT JOIN when orphans exist and names the count", () => {
    const verdict = getJoinVerdict(
      makeResult({ containment: 0.88, orphan_count: 12, pattern: "stable_with_orphans" }),
      null,
    );
    expect(verdict.level).toBe("caution");
    expect(verdict.symptom).toContain("12");
    expect(verdict.remedy).toContain("LEFT JOIN");
  });

  it("warns about small samples", () => {
    const verdict = getJoinVerdict(
      makeResult({ pattern: "small_sample_only", src_distinct: 4 }), null);
    expect(verdict.level).toBe("caution");
    expect(verdict.symptom).toContain("표본");
  });

  it("returns unknown when there is no value data", () => {
    const verdict = getJoinVerdict(null, null);
    expect(verdict.level).toBe("unknown");
    expect(verdict.remedy).toBeNull();
  });
});

describe("getWorstVerdictIndex", () => {
  it("ranks danger over caution over unknown over safe", () => {
    const verdicts: JoinVerdict[] = [
      { level: "safe", symptom: "a", remedy: null },
      { level: "caution", symptom: "b", remedy: null },
      { level: "danger", symptom: "c", remedy: null },
      { level: "unknown", symptom: "d", remedy: null },
    ];
    expect(getWorstVerdictIndex(verdicts)).toBe(2);
  });

  it("returns the first occurrence when levels tie", () => {
    const verdicts: JoinVerdict[] = [
      { level: "safe", symptom: "a", remedy: null },
      { level: "caution", symptom: "b", remedy: null },
      { level: "caution", symptom: "c", remedy: null },
    ];
    expect(getWorstVerdictIndex(verdicts)).toBe(1);
  });

  it("returns -1 for an empty draft", () => {
    expect(getWorstVerdictIndex([])).toBe(-1);
  });
});
