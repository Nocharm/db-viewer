import { describe, expect, it } from "vitest";

import { NODE_CONFIRM_THRESHOLD, mergeGraphs, planMerge } from "./graph-merge";
import type { GraphNode, GraphResponse } from "./types";

function makeNode(id: number): GraphNode {
  return {
    id, schema: "dbo", name: `T_${id}`, type: "table", row_count: 0,
    dmv_unresolved: false, lineage_flag: null, unresolved_dep_count: 0, columns: [],
  };
}

function makeGraph(ids: number[], anchor = ids[0]): GraphResponse {
  return {
    snapshot_id: 1, anchor_id: anchor, depth: 1,
    nodes: ids.map(makeNode),
    edges: [],
  };
}

describe("mergeGraphs", () => {
  it("unions nodes and edges by id without duplicates", () => {
    const merged = mergeGraphs(makeGraph([1, 2]), makeGraph([2, 3]));
    expect(merged.nodes.map((n) => n.id).sort()).toEqual([1, 2, 3]);
  });

  it("returns incoming as-is when there is no current graph", () => {
    const incoming = makeGraph([1]);
    expect(mergeGraphs(null, incoming)).toBe(incoming);
  });
});

describe("planMerge", () => {
  it("does not ask below the threshold", () => {
    const plan = planMerge(makeGraph([1]), makeGraph([2, 3]));
    expect(plan.needsConfirm).toBe(false);
    expect(plan.addedCount).toBe(2);
  });

  it("asks when the expansion crosses the threshold", () => {
    const current = makeGraph(Array.from({ length: 30 }, (_, i) => i));
    const incoming = makeGraph(Array.from({ length: 20 }, (_, i) => 100 + i));
    const plan = planMerge(current, incoming);
    expect(plan.total).toBe(50);
    expect(plan.needsConfirm).toBe(true);
  });

  it("does not re-ask once already past the threshold", () => {
    const big = makeGraph(Array.from({ length: NODE_CONFIRM_THRESHOLD + 5 }, (_, i) => i));
    const plan = planMerge(big, makeGraph([999]));
    expect(plan.needsConfirm).toBe(false);
  });
});
