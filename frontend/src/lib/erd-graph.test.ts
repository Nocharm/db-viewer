import { describe, expect, it } from "vitest";

import type { GraphEdge, GraphNode } from "./types";
import { groupConnectedComponents } from "./erd-graph";

function makeNode(id: number): GraphNode {
  return {
    id, schema: "dbo", name: `T${id}`, type: "table", row_count: 0,
    dmv_unresolved: false, lineage_flag: null, unresolved_dep_count: 0, columns: [],
  } as GraphNode;
}

function makeEdge(id: string, src: number, tgt: number): GraphEdge {
  return { id, kind: "fk", src_object_id: src, tgt_object_id: tgt, columns: [] } as GraphEdge;
}

describe("groupConnectedComponents", () => {
  it("splits disconnected clusters and sorts big-first, then by min id", () => {
    const nodes = [1, 2, 3, 4, 5, 6].map(makeNode);
    const edges = [makeEdge("a", 5, 6), makeEdge("b", 1, 2), makeEdge("c", 2, 3)];

    const groups = groupConnectedComponents(nodes, edges);

    expect(groups.map((g) => g.map((n) => n.id).sort((x, y) => x - y)))
      .toEqual([[1, 2, 3], [5, 6], [4]]); // 크기 3 → 2 → 고립 1
  });

  it("keeps an empty graph empty", () => {
    expect(groupConnectedComponents([], [])).toEqual([]);
  });
});
