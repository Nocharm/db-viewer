import { describe, expect, it } from "vitest";

import type { GateResult } from "./api";
import type { ContainmentResponse } from "./types";
import { applyConfirm, applyContainment, applyGateResult, createInitialState } from "./verify-flow";
import { getVerifyStepStates } from "./verify-steps";

const passGate: GateResult = {
  verdict: "pass", reason: null, threshold: 0.9,
  src: { qname: "dbo.A", column: "X", data_type: "int", family: "int",
         sample_rows: 200, sample_distinct: 40, ratio: 0.2, cached: false },
  tgt: { qname: "dbo.B", column: "X", data_type: "int", family: "int",
         sample_rows: 150, sample_distinct: 150, ratio: 1, cached: false },
};
const blockedGate: GateResult = { ...passGate, verdict: "blocked", reason: "type_mismatch" };
const containment = { containment: 1, cardinality: "N:1" } as ContainmentResponse;

describe("verify step states", () => {
  it("locks every step until a pair is picked", () => {
    expect(getVerifyStepStates(createInitialState(), false, false))
      .toEqual(["locked", "locked", "locked", "locked"]);
  });

  it("opens the gate as the current step once a pair exists", () => {
    expect(getVerifyStepStates(createInitialState(), true, false))
      .toEqual(["current", "locked", "locked", "locked"]);
  });

  it("marks a blocked gate without unlocking the rest", () => {
    const state = applyGateResult(createInitialState(), blockedGate);
    expect(getVerifyStepStates(state, true, false))
      .toEqual(["blocked", "locked", "locked", "locked"]);
  });

  it("hands the turn to containment after the gate passes", () => {
    const state = applyGateResult(createInitialState(), passGate);
    expect(getVerifyStepStates(state, true, false))
      .toEqual(["done", "current", "locked", "locked"]);
  });

  it("opens the optional sample and confirm together after containment", () => {
    const state = applyContainment(applyGateResult(createInitialState(), passGate), containment);
    expect(getVerifyStepStates(state, true, false))
      .toEqual(["done", "done", "current", "current"]);
    // 샘플은 봤는지 여부만 바꾼다 — 확정 가능 여부에는 영향이 없다
    expect(getVerifyStepStates(state, true, true))
      .toEqual(["done", "done", "done", "current"]);
  });

  it("closes out every step once confirmed", () => {
    const state = applyConfirm(
      applyContainment(applyGateResult(createInitialState(), passGate), containment),
    );
    expect(getVerifyStepStates(state, true, true))
      .toEqual(["done", "done", "done", "done"]);
  });
});
