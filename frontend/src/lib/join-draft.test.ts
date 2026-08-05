import { describe, expect, it } from "vitest";

import {
  addStep, canAddStep, EMPTY_DRAFT, getDraftTables, MAX_JOIN_STEPS,
  removeStep, setStepJoinType, type JoinColumnRef,
} from "./join-draft";

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
    expect(result.ok === false && result.reason).toContain("같은 테이블");
  });

  it("requires later steps to touch a table already in the draft", () => {
    const draft = addStep(EMPTY_DRAFT, ORDER, LOG);
    expect(canAddStep(draft, LOG_USER, USER)).toEqual({ ok: true });
    const disconnected = canAddStep(draft, DEPT, OTHER);
    expect(disconnected.ok).toBe(false);
    expect(disconnected.ok === false && disconnected.reason).toContain("이어지지");
  });

  it("rejects a duplicate pair", () => {
    const draft = addStep(EMPTY_DRAFT, ORDER, LOG);
    const again = canAddStep(draft, ORDER, LOG);
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.reason).toContain("이미");
  });

  it("caps the draft at MAX_JOIN_STEPS", () => {
    let draft = addStep(EMPTY_DRAFT, ORDER, LOG);
    for (let i = 0; i < MAX_JOIN_STEPS - 1; i += 1) {
      draft = addStep(draft, LOG, ref(`ATM.T_${i}`, "X", 100 + i));
    }
    expect(draft.steps).toHaveLength(MAX_JOIN_STEPS);
    const overflow = canAddStep(draft, LOG, ref("ATM.T_LAST", "X", 999));
    expect(overflow.ok).toBe(false);
    expect(overflow.ok === false && overflow.reason).toContain(String(MAX_JOIN_STEPS));
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
