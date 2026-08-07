import { describe, expect, it } from "vitest";

import type { ContainmentResponse } from "./types";
import type { GateResult } from "./api";
import {
  applyConfirm, applyContainment, applyGateResult,
  canConfirm, canRunContainment, createInitialState, resetForNewPair,
} from "./verify-flow";

const passGate: GateResult = {
  verdict: "pass", reason: null, threshold: 0.9,
  src: { qname: "dbo.A", column: "X", data_type: "int", family: "int",
         sample_rows: 200, sample_distinct: 40, ratio: 0.2, cached: false },
  tgt: { qname: "dbo.B", column: "X", data_type: "int", family: "int",
         sample_rows: 150, sample_distinct: 150, ratio: 1, cached: false },
};
const blockedGate: GateResult = { ...passGate, verdict: "blocked", reason: "type_mismatch" };
const containment = { containment: 1, cardinality: "N:1" } as ContainmentResponse;

describe("verify flow", () => {
  it("starts at pick and blocks containment until the gate passes", () => {
    const s0 = createInitialState();
    expect(s0.step).toBe("pick");
    expect(canRunContainment(s0)).toBe(false);

    const blocked = applyGateResult(s0, blockedGate);
    expect(blocked.step).toBe("gated");
    expect(canRunContainment(blocked)).toBe(false); // 차단 게이트는 진행 불가

    const passed = applyGateResult(s0, passGate);
    expect(canRunContainment(passed)).toBe(true);
    expect(canConfirm(passed)).toBe(false);
  });

  it("walks gate -> containment -> confirm in order", () => {
    const validated = applyContainment(applyGateResult(createInitialState(), passGate), containment);
    expect(validated.step).toBe("validated");
    expect(canConfirm(validated)).toBe(true);
    expect(applyConfirm(validated).step).toBe("confirmed");
  });

  it("resets everything when the pair changes", () => {
    const validated = applyContainment(applyGateResult(createInitialState(), passGate), containment);
    expect(resetForNewPair()).toEqual(createInitialState());
    expect(validated.containment).not.toBeNull(); // 원본 불변
  });
});
