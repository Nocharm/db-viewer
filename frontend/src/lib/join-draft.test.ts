import { describe, expect, it } from "vitest";

import {
  addStep, canAddStep, EMPTY_DRAFT, getDraftTables, getStepKey, MAX_JOIN_STEPS,
  removeStep, setStepJoinType, setStepResult, type JoinColumnRef,
} from "./join-draft";
import { getJoinVerdict } from "./join-verdict";

function ref(qname: string, column: string, columnId: number): JoinColumnRef {
  return { objectId: qname.length, qname, columnId, column };
}

const ORDER = ref("ATM.T_ORDER", "ORDER_ID", 1);
const LOG = ref("ATM.T_ORDER_LOG", "ORDER_ID", 2);
const LOG_USER = ref("ATM.T_ORDER_LOG", "USER_ID", 3);
const USER = ref("ATM.T_USER", "USER_ID", 4);
const DEPT = ref("ATM.T_DEPT", "DEPT_CD", 5);
const OTHER = ref("ATM.T_SHIP", "SHIP_NO", 6);

describe("canAddStep", () => {
  it("accepts any pair as the first step", () => {
    expect(canAddStep(EMPTY_DRAFT, ORDER, LOG)).toEqual({ ok: true });
  });

  it("rejects a pair that joins a table to itself", () => {
    const result = canAddStep(EMPTY_DRAFT, ORDER, ref("ATM.T_ORDER", "CUST_ID", 9));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("same_table");
  });

  it("requires later steps to touch a table already in the draft", () => {
    const draft = addStep(EMPTY_DRAFT, ORDER, LOG);
    expect(canAddStep(draft, LOG_USER, USER)).toEqual({ ok: true });
    const disconnected = canAddStep(draft, DEPT, OTHER);
    expect(disconnected.ok).toBe(false);
    expect(disconnected.ok === false && disconnected.reason).toBe("disconnected");
  });

  it("rejects a duplicate pair", () => {
    const draft = addStep(EMPTY_DRAFT, ORDER, LOG);
    const again = canAddStep(draft, ORDER, LOG);
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.reason).toBe("duplicate");
  });

  it("rejects a duplicate pair regardless of drag direction", () => {
    // Users can drag from ORDER→LOG or LOG→ORDER; both must reject as duplicate.
    const draft = addStep(EMPTY_DRAFT, ORDER, LOG);
    const reversed = canAddStep(draft, LOG, ORDER);
    expect(reversed.ok).toBe(false);
    expect(reversed.ok === false && reversed.reason).toBe("duplicate");
  });

  it("caps the draft at MAX_JOIN_STEPS", () => {
    let draft = addStep(EMPTY_DRAFT, ORDER, LOG);
    for (let i = 0; i < MAX_JOIN_STEPS - 1; i += 1) {
      draft = addStep(draft, LOG, ref(`ATM.T_${i}`, "X", 100 + i));
    }
    expect(draft.steps).toHaveLength(MAX_JOIN_STEPS);
    const overflow = canAddStep(draft, LOG, ref("ATM.T_LAST", "X", 999));
    expect(overflow.ok).toBe(false);
    expect(overflow.ok === false && overflow.reason).toBe("step_cap");
    expect(overflow.ok === false && overflow.max).toBe(MAX_JOIN_STEPS);
  });
});

describe("addStep", () => {
  it("starts a step in the verifying state with inner as the default join", () => {
    const draft = addStep(EMPTY_DRAFT, ORDER, LOG);
    expect(draft.steps[0]).toMatchObject({
      status: "verifying", joinType: "inner", result: null, verdict: null,
    });
  });

  it("does not mutate the input draft", () => {
    const before = addStep(EMPTY_DRAFT, ORDER, LOG);
    addStep(before, LOG_USER, USER);
    expect(before.steps).toHaveLength(1);
  });
});

describe("getDraftTables", () => {
  it("lists every table in draft order, first step's left first", () => {
    let draft = addStep(EMPTY_DRAFT, ORDER, LOG);
    draft = addStep(draft, LOG_USER, USER);
    expect(getDraftTables(draft)).toEqual([
      "ATM.T_ORDER", "ATM.T_ORDER_LOG", "ATM.T_USER",
    ]);
  });
});

describe("removeStep and setStepJoinType", () => {
  it("removes by index without touching neighbours", () => {
    let draft = addStep(EMPTY_DRAFT, ORDER, LOG);
    draft = addStep(draft, LOG_USER, USER);
    expect(removeStep(draft, 0).steps).toHaveLength(1);
    expect(removeStep(draft, 0).steps[0].right.qname).toBe("ATM.T_USER");
  });

  it("switches a step to left join", () => {
    const draft = setStepJoinType(addStep(EMPTY_DRAFT, ORDER, LOG), 0, "left");
    expect(draft.steps[0].joinType).toBe("left");
  });
});

describe("setStepResult", () => {
  it("no-ops when the target step was removed mid-flight (race guard)", () => {
    // Two steps; the first (A) will be removed while its T2 query is still in flight.
    let draft = addStep(EMPTY_DRAFT, ORDER, LOG); // A
    draft = addStep(draft, LOG_USER, USER); // B — survives
    const keyForA = getStepKey(draft.steps[0]);
    const survivorBefore = draft.steps[1];
    draft = removeStep(draft, 0); // B shifts into index 0 — the position A's index used to occupy
    // A's async result arrives late, keyed to A — must not land on B just because B is now at index 0
    const result = setStepResult(draft, keyForA, "ready", null, getJoinVerdict(null, null));
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toEqual(survivorBefore);
  });

  it("updates the step matching the given key", () => {
    let draft = addStep(EMPTY_DRAFT, ORDER, LOG);
    draft = addStep(draft, LOG_USER, USER);
    const keyForSecond = getStepKey(draft.steps[1]);
    const verdict = getJoinVerdict(null, null);
    const result = setStepResult(draft, keyForSecond, "no_data", null, verdict);
    expect(result.steps[0].status).toBe("verifying"); // untouched
    expect(result.steps[1]).toMatchObject({ status: "no_data", result: null, verdict });
  });
});
