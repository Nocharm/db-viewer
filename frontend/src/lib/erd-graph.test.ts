import { describe, expect, it } from "vitest";

import type { GraphEdge, GraphNode } from "./types";
import {
  applyManualPositions, clampMenuPosition, filterGraphBySchema, groupConnectedComponents,
  packGroupRows, type PlacedNode,
} from "./erd-graph";

function makeNode(id: number, schema = "dbo"): GraphNode {
  return {
    id, schema, name: `T${id}`, type: "table", row_count: 0,
    dmv_unresolved: false, lineage_flag: null, unresolved_dep_count: 0, columns: [],
  } as GraphNode;
}

function makeEdge(id: string, src: number, tgt: number): GraphEdge {
  return { id, kind: "fk", src_object_id: src, tgt_object_id: tgt, columns: [] } as GraphEdge;
}

describe("groupConnectedComponents", () => {
  it("splits disconnected clusters and sorts big-first, then by min id", () => {
    const nodes = [1, 2, 3, 4, 5, 6].map((id) => makeNode(id));
    const edges = [makeEdge("a", 5, 6), makeEdge("b", 1, 2), makeEdge("c", 2, 3)];

    const groups = groupConnectedComponents(nodes, edges);

    expect(groups.map((g) => g.map((n) => n.id).sort((x, y) => x - y)))
      .toEqual([[1, 2, 3], [5, 6], [4]]); // 크기 3 → 2 → 고립 1
  });

  it("keeps an empty graph empty", () => {
    expect(groupConnectedComponents([], [])).toEqual([]);
  });

  it("ignores edges referencing absent nodes", () => {
    const nodes = [1, 2].map((id) => makeNode(id));
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

describe("packGroupRows", () => {
  it("keeps an empty input empty", () => {
    expect(packGroupRows([], 10)).toEqual([]);
  });

  it("places a single box at the origin", () => {
    expect(packGroupRows([{ width: 300, height: 100 }], 10)).toEqual([{ x: 0, y: 0 }]);
  });

  it("wraps into rows instead of one column", () => {
    // 동일 박스 9개 — 세로 일렬(예전 동작)이라면 y가 8단계로 늘어난다.
    // 패킹은 여러 행으로 접어 행 수 < 박스 수가 되어야 한다.
    const boxes = Array.from({ length: 9 }, () => ({ width: 300, height: 100 }));

    const offsets = packGroupRows(boxes, 20);

    const rows = new Set(offsets.map((o) => o.y)).size;
    expect(rows).toBeGreaterThan(1); // 한 행에 다 넣지도 않고
    expect(rows).toBeLessThan(9); // 한 열로 쌓지도 않는다
    // 같은 행 안에서는 gap만큼 띄워 겹치지 않는다
    expect(offsets[1]).toEqual({ x: 320, y: 0 });
  });

  it("never wraps a box wider than the computed target width", () => {
    const boxes = [
      { width: 5000, height: 100 }, // 목표 폭보다 넓은 그룹
      { width: 300, height: 100 },
    ];

    const offsets = packGroupRows(boxes, 20);

    expect(offsets[0]).toEqual({ x: 0, y: 0 }); // 첫 박스는 항상 원점
    // 넓은 박스 옆이 아니라 다음 행으로 — 목표 폭이 widest로 클램프되므로
    expect(offsets[1].y).toBeGreaterThan(0);
  });

  it("is deterministic for the same input", () => {
    const boxes = [
      { width: 400, height: 120 }, { width: 200, height: 80 }, { width: 350, height: 90 },
    ];

    expect(packGroupRows(boxes, 30)).toEqual(packGroupRows(boxes, 30));
  });
});

describe("filterGraphBySchema", () => {
  const nodes = [makeNode(1, "dbo"), makeNode(2, "dbo"), makeNode(3, "hr")];
  const edges = [makeEdge("a", 1, 2), makeEdge("b", 2, 3)]; // b는 스키마 경계를 넘는다

  it("returns the original references when no filter is set", () => {
    const result = filterGraphBySchema(nodes, edges, null);

    expect(result.nodes).toBe(nodes);
    expect(result.edges).toBe(edges);
  });

  it("keeps only the schema's nodes and drops boundary-crossing edges", () => {
    const result = filterGraphBySchema(nodes, edges, "dbo");

    expect(result.nodes.map((n) => n.id)).toEqual([1, 2]);
    expect(result.edges.map((e) => e.id)).toEqual(["a"]); // 2-3 엣지는 hr 쪽 끝이 잘려 제외
  });

  it("returns empty sets for a schema with no nodes", () => {
    const result = filterGraphBySchema(nodes, edges, "absent");

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });
});

describe("clampMenuPosition", () => {
  it("keeps an interior position unchanged", () => {
    expect(clampMenuPosition(100, 100, 200, 180, 1440, 900)).toEqual({ x: 100, y: 100 });
  });

  it("pulls a menu opened near the bottom-right corner inside", () => {
    expect(clampMenuPosition(1400, 880, 200, 180, 1440, 900))
      .toEqual({ x: 1240, y: 720 }); // viewport - menu 크기까지 안쪽으로
  });

  it("never returns negative coordinates on tiny viewports", () => {
    expect(clampMenuPosition(5, 5, 400, 400, 300, 300)).toEqual({ x: 0, y: 0 });
  });
});
