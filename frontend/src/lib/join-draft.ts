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
 * canAddStep의 중복 규칙이 드래프트 내 유일성을 이미 보장한다.
 * Stable step identity — the column pair, not position; canAddStep's duplicate
 * rule already guarantees uniqueness within a draft. */
export function getStepKey(step: JoinStep): string {
  return `${step.left.columnId}-${step.right.columnId}`;
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
  };
  return { steps: [...draft.steps, step] };
}

export function removeStep(draft: JoinDraft, index: number): JoinDraft {
  return { steps: draft.steps.filter((_, i) => i !== index) };
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
