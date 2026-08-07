/** /verify 단계 상태머신 — 게이트 통과 전 containment·확정 진입을 막는다. */

import type { GateResult } from "./api";
import type { ContainmentResponse } from "./types";

export type VerifyStep = "pick" | "gated" | "validated" | "confirmed";

export interface VerifyState {
  step: VerifyStep;
  gate: GateResult | null;
  containment: ContainmentResponse | null;
}

export function createInitialState(): VerifyState {
  return { step: "pick", gate: null, containment: null };
}

export function applyGateResult(state: VerifyState, gate: GateResult): VerifyState {
  return { ...state, step: "gated", gate, containment: null };
}

export function applyContainment(
  state: VerifyState, result: ContainmentResponse,
): VerifyState {
  return { ...state, step: "validated", containment: result };
}

export function applyConfirm(state: VerifyState): VerifyState {
  return { ...state, step: "confirmed" };
}

export function resetForNewPair(): VerifyState {
  return createInitialState();
}

export function canRunContainment(state: VerifyState): boolean {
  return state.gate?.verdict === "pass";
}

export function canConfirm(state: VerifyState): boolean {
  return state.step === "validated" && state.containment !== null;
}
