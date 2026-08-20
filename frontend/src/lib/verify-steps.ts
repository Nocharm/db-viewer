/** /verify 1~4단계의 표시 상태 — 흐름 다이어그램과 좌측 네비게이터가 함께 쓴다.
 *
 * 상태머신(verify-flow)은 "무엇을 할 수 있는가"만 안다. 화면은 그 위에 "몇 번째 단계가
 * 끝났고 지금 어디인지"를 얹어야 하는데, 그 계산이 두 컴포넌트에 흩어지면 서로 다른
 * 색을 칠하게 된다 — 여기 한 곳에서 만든다.
 * Display state for the four steps, shared by the flow diagram and the side navigator.
 */

import { canConfirm, canRunContainment, type VerifyState } from "./verify-flow";

export type VerifyStepState = "done" | "current" | "locked" | "blocked";

/** 1~4단계 상태를 순서대로 / the four step states, in order. */
export function getVerifyStepStates(
  state: VerifyState,
  hasPair: boolean,
  /** 3단계 샘플을 한 번이라도 불러왔는지 — 선택 단계라 흐름을 막지는 않는다 */
  sampleSeen: boolean,
): VerifyStepState[] {
  const gate: VerifyStepState = !hasPair
    ? "locked"
    : state.gate?.verdict === "pass" ? "done" : state.gate ? "blocked" : "current";
  const containment: VerifyStepState = !canRunContainment(state)
    ? "locked"
    : state.containment ? "done" : "current";
  const sample: VerifyStepState = !state.containment
    ? "locked"
    : sampleSeen ? "done" : "current";
  const confirm: VerifyStepState = state.step === "confirmed"
    ? "done"
    : canConfirm(state) ? "current" : "locked";
  return [gate, containment, sample, confirm];
}
