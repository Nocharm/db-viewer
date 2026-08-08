import { describe, expect, it } from "vitest";

import type { GraphEdge, GraphNode } from "./types";
import { applyManualPositions, groupConnectedComponents, type PlacedNode } from "./erd-graph";

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

  it("ignores edges referencing absent nodes", () => {
    const nodes = [1, 2].map(makeNode);
    const edges = [makeEdge("a", 1, 2), makeEdge("b", 2, 999)]; // 999는 없음

    const groups = groupConnectedComponents(nodes, edges);

    expect(groups.map((g) => g.map((n) => n.id).sort((x, y) => x - y)))
      .toEqual([[1, 2]]); // 999 엣지는 무시, 1-2만 연결
  });
});

describe("applyManualPositions", () => {
  const makePlaced = (): Map<number, PlacedNode> => new Map([
    [1, { x: 0, y: 0, width: 260, height: 40 }],
    [2, { x: 300, y: 0, width: 260, height: 40 }],
  ]);

  it("overrides coordinates for moved nodes but keeps ELK sizes", () => {
    const merged = applyManualPositions(makePlaced(), new Map([[1, { x: 50, y: 80 }]]));

    expect(merged.get(1)).toEqual({ x: 50, y: 80, width: 260, height: 40 });
    expect(merged.get(2)).toEqual({ x: 300, y: 0, width: 260, height: 40 }); // 미이동 노드 그대로
  });

  it("ignores moved ids that are absent from the placement", () => {
    const merged = applyManualPositions(makePlaced(), new Map([[999, { x: 1, y: 2 }]]));

    expect(merged.size).toBe(2);
    expect(merged.has(999)).toBe(false);
  });

  it("returns a new Map and leaves inputs untouched", () => {
    const placed = makePlaced();
    const merged = applyManualPositions(placed, new Map([[1, { x: 50, y: 80 }]]));

    expect(merged).not.toBe(placed);
    expect(placed.get(1)).toEqual({ x: 0, y: 0, width: 260, height: 40 });
  });
});
