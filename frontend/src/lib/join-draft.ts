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

export type CanAddResult = { ok: true } | { ok: false; reason: string };

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
    return { ok: false, reason: "같은 테이블끼리는 연결할 수 없습니다" };
  }
  if (draft.steps.length >= MAX_JOIN_STEPS) {
    return { ok: false, reason: `조인은 최대 ${MAX_JOIN_STEPS}단계까지입니다` };
  }
  if (draft.steps.some((step) => isSamePair(step, left, right))) {
    return { ok: false, reason: "이미 추가된 조인입니다" };
  }
  if (draft.steps.length === 0) return { ok: true };

  const tables = getDraftTables(draft);
  if (!tables.includes(left.qname) && !tables.includes(right.qname)) {
    return { ok: false, reason: "기존 조인과 이어지지 않습니다 — 한쪽은 이미 들어온 테이블이어야 합니다" };
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

export function setStepResult(
  draft: JoinDraft,
  index: number,
  status: StepStatus,
  result: ContainmentResponse | null,
  verdict: JoinVerdict,
): JoinDraft {
  return replaceStep(draft, index, { status, result, verdict });
}
