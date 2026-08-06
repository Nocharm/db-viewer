/** 조인 드래프트 — 스텝 누적과 연결성 규칙. 순수 함수만 둔다.
 * Join draft state: step accumulation and the connectivity rule. */

import type { JoinVerdict } from "./join-verdict";
import type { ContainmentResponse } from "./types";

/** 조인 스텝 상한 — backend/app/api/join_check.py:BATCH_TARGET_LIMIT과 같은 값 */
export const MAX_JOIN_STEPS = 8;

export interface JoinColumnRef {
  objectId: number;
  /** "ATM.T_ORDER" */
  qname: string;
  columnId: number;
  column: string;
}

export type JoinType = "inner" | "left";
export type StepStatus = "verifying" | "ready" | "no_data" | "failed";

export interface JoinStep {
  left: JoinColumnRef;
  right: JoinColumnRef;
  joinType: JoinType;
  status: StepStatus;
  result: ContainmentResponse | null;
  verdict: JoinVerdict | null;
  /** POST /api/relations/confirm 성공 여부 — 두 번째 클릭이 모호하지 않도록 유지한다.
   * whether the user has confirmed this pair; kept so a second click isn't ambiguous. */
  confirmed: boolean;
}

export interface JoinDraft {
  steps: JoinStep[];
}

export const EMPTY_DRAFT: JoinDraft = { steps: [] };

// 코드로 두고 문구는 호출자(ErdCanvas)가 i18n으로 렌더 — join-verdict의 symptom/remedy와 달리
// 이건 사용자 액션에 대한 UI 피드백이라 도메인 라벨 예외(카테고리 등)에 해당하지 않는다.
// a code, not text — the caller renders it via i18n; unlike join-verdict's symptom/remedy,
// this is UI feedback for a user action, not a domain label, so it doesn't get the Korean-only carve-out.
export type CanAddFailureReason = "same_table" | "step_cap" | "duplicate" | "disconnected";
export type CanAddResult =
  | { ok: true }
  | { ok: false; reason: CanAddFailureReason; max?: number };

/** 스텝의 안정 식별자 — 위치(index)가 아니라 컬럼 페어로 식별한다.
 * canAddStep의 중복 규칙이 드래프트 내 유일성을 이미 보장한다. left/right 페어만 있으면
 * 되므로 JoinStep 전체가 아니라 그 부분 타입을 받는다 — addStep으로 스텝 객체가 생기기
 * 전, 막 resolve된 두 컬럼 참조만 가지고도 같은 키를 계산할 수 있다.
 * Stable step identity — the column pair, not position; canAddStep's duplicate rule
 * already guarantees uniqueness within a draft. Takes just the left/right pair rather
 * than a full JoinStep, so the same key can be computed before addStep ever builds the
 * step object, from two freshly-resolved column refs alone. */
export function getStepKey(pair: { left: JoinColumnRef; right: JoinColumnRef }): string {
  return `${pair.left.columnId}-${pair.right.columnId}`;
}

/** 드래프트에 들어온 테이블 — 첫 스텝의 left가 FROM이 된다 / tables in draft order. */
export function getDraftTables(draft: JoinDraft): string[] {
  const tables: string[] = [];
  for (const step of draft.steps) {
    for (const qname of [step.left.qname, step.right.qname]) {
      if (!tables.includes(qname)) tables.push(qname);
    }
  }
  return tables;
}

function isSamePair(step: JoinStep, left: JoinColumnRef, right: JoinColumnRef): boolean {
  const a = [step.left.columnId, step.right.columnId].sort().join("-");
  const b = [left.columnId, right.columnId].sort().join("-");
  return a === b;
}

/**
 * 새 스텝을 받을 수 있는지 — 끊긴 조인은 곱집합이 되어 미리보기가 무의미하다.
 * The connectivity rule: every step after the first must touch an existing table.
 */
export function canAddStep(
  draft: JoinDraft,
  left: JoinColumnRef,
  right: JoinColumnRef,
): CanAddResult {
  if (left.qname === right.qname) {
    return { ok: false, reason: "same_table" };
  }
  if (draft.steps.length >= MAX_JOIN_STEPS) {
    return { ok: false, reason: "step_cap", max: MAX_JOIN_STEPS };
  }
  if (draft.steps.some((step) => isSamePair(step, left, right))) {
    return { ok: false, reason: "duplicate" };
  }
  if (draft.steps.length === 0) return { ok: true };

  const tables = getDraftTables(draft);
  if (!tables.includes(left.qname) && !tables.includes(right.qname)) {
    return { ok: false, reason: "disconnected" };
  }
  return { ok: true };
}

/** 검증 대기 상태로 스텝 추가 — 호출자가 T2를 실행하고 setStepResult로 채운다. */
export function addStep(
  draft: JoinDraft,
  left: JoinColumnRef,
  right: JoinColumnRef,
): JoinDraft {
  const step: JoinStep = {
    left, right, joinType: "inner", status: "verifying", result: null, verdict: null,
    confirmed: false,
  };
  return { steps: [...draft.steps, step] };
}

/**
 * 순서를 지키며 "이미 들어온 테이블과 이어지는" 스텝만 남긴다 — canAddStep의 삽입 규칙,
 * backend join_preview.py:_check_connectivity와 같은 순서 기반 판정이다. 전체 그래프가
 * 하나로 이어져 있는지(union-find)만 보면 부족하다: 뒤쪽에 살아남은 엣지가 "앞쪽 순서상"
 * 아직 등장하지 않은 테이블을 이어준다면, 집합만 보면 연결돼 있어도 서버는 그 위치에서
 * 여전히 거부한다. 그래서 다시 스텝을 훑으며 그 시점까지 이어진 테이블만으로 판단한다.
 *
 * Keeps only the steps that, walking in order, touch a table already introduced —
 * canAddStep's own insertion rule, and the same order-dependent walk backend
 * join_preview.py's _check_connectivity performs. A plain union-find over the whole
 * edge set isn't enough: a surviving later edge can bridge tables that, in array
 * order, haven't been introduced yet, so the set looks connected while the server
 * still rejects that position. Re-walking the array is what actually matches the server.
 */
function pruneDisconnected(steps: JoinStep[]): JoinStep[] {
  const seen = new Set<string>();
  const kept: JoinStep[] = [];
  for (const step of steps) {
    if (seen.size > 0 && !seen.has(step.left.qname) && !seen.has(step.right.qname)) continue;
    kept.push(step);
    seen.add(step.left.qname);
    seen.add(step.right.qname);
  }
  return kept;
}

/**
 * 제거 후 끊긴 뒤쪽 스텝을 함께 지운다 — 그대로 두면 UI는 받아주고 서버는 400
 * "disconnected join step"으로 거부하는 상태가 만들어진다. 사용자가 지운 건 하나지만,
 * 그 스텝이 유일한 다리였던 테이블은 애초에 canAddStep이 그 다리를 통해서만 들어오게
 * 했으므로 함께 정리하는 편이 "미리보기 가능한 드래프트"라는 불변식을 지키는 가장
 * 단순한 방법이다. 몇 개가 함께 지워졌는지는 호출자가 반환된 길이 차이로 알 수 있다.
 *
 * Cascades the removal to any now-orphaned trailing step — otherwise the draft the UI
 * holds can be one the server's 400 "disconnected join step" rejects. Only one step was
 * asked for, but canAddStep only ever let an orphaned table in through the step being
 * removed, so cascading keeps "every draft the UI holds is previewable" true without a
 * second connectivity check anywhere else. Callers can tell how many were swept by
 * comparing lengths before and after.
 */
export function removeStep(draft: JoinDraft, index: number): JoinDraft {
  const kept = draft.steps.filter((_, i) => i !== index);
  return { steps: pruneDisconnected(kept) };
}

/**
 * 이 스텝이 "닫는 엣지"인가 — 양쪽 테이블이 이전 스텝들로 이미 다 들어와 있으면 새
 * JOIN이 아니라 기존 clause에 AND로 붙는다. 그 자리엔 독립된 LEFT/RIGHT 방향이 없어
 * backend join_preview.py:_check_connectivity가 이런 스텝의 join_type="left"를 400으로
 * 거부한다 — 여기서 미리 걸러 LEFT JOIN 버튼 자체를 숨기면 그 왕복이 필요 없다.
 *
 * Whether a step is a "closing" edge — both its tables were already introduced by
 * earlier steps, so it becomes an AND on an existing JOIN clause with no independent
 * direction to honour. backend join_preview.py's _check_connectivity rejects
 * join_type="left" there with a 400; detecting it here lets the UI hide the LEFT JOIN
 * button before that round trip instead of after.
 */
export function isClosingStep(draft: JoinDraft, index: number): boolean {
  if (index <= 0) return false;
  const seen = new Set<string>();
  for (let i = 0; i < index; i += 1) {
    seen.add(draft.steps[i].left.qname);
    seen.add(draft.steps[i].right.qname);
  }
  const step = draft.steps[index];
  return seen.has(step.left.qname) && seen.has(step.right.qname);
}

function replaceStep(
  draft: JoinDraft, index: number, patch: Partial<JoinStep>,
): JoinDraft {
  return {
    steps: draft.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
  };
}

export function setStepJoinType(
  draft: JoinDraft, index: number, joinType: JoinType,
): JoinDraft {
  return replaceStep(draft, index, { joinType });
}

/**
 * 스텝 하나의 검증 결과를 채운다 — 위치가 아니라 stepKey로 찾는다.
 * 비동기 응답이 도착했을 때 그 사이 스텝이 지워졌으면 조용히 no-op한다(레이스 가드).
 * Resolved by stepKey, not position — if the target step was removed while its
 * query was in flight, this is a silent no-op instead of corrupting another step.
 */
export function setStepResult(
  draft: JoinDraft,
  stepKey: string,
  status: StepStatus,
  result: ContainmentResponse | null,
  verdict: JoinVerdict,
): JoinDraft {
  const index = draft.steps.findIndex((step) => getStepKey(step) === stepKey);
  if (index === -1) return draft;
  return replaceStep(draft, index, { status, result, verdict });
}

/** 확정 API 성공 후 상태 반영 — setStepResult와 같은 stepKey 조회·레이스 가드 패턴.
 * Marks a step confirmed after the API call succeeds; same stepKey lookup and
 * race guard as setStepResult (a removal mid-flight is a silent no-op). */
export function setStepConfirmed(draft: JoinDraft, stepKey: string): JoinDraft {
  const index = draft.steps.findIndex((step) => getStepKey(step) === stepKey);
  if (index === -1) return draft;
  return replaceStep(draft, index, { confirmed: true });
}
