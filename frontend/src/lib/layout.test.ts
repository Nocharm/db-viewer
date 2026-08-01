import { describe, expect, it } from "vitest";

import { MAX_VISIBLE_COLUMNS, NODE_WIDTH, estimateNodeSize, layoutGraph } from "./layout";
import type { GraphColumn, GraphNode } from "./types";

function makeNode(type: "table" | "view", columnCount: number): GraphNode {
  const columns: GraphColumn[] = Array.from({ length: columnCount }, (_, i) => ({
    id: i, name: `C${i}`, data_type: "int", is_pk: i === 0,
    is_nullable: false, is_computed: false,
  }));
  return {
    id: 1, schema: "dbo", name: "X", type, row_count: 0,
    dmv_unresolved: false, lineage_flag: null, unresolved_dep_count: 0, columns,
  };
}

describe("estimateNodeSize", () => {
  it("collapses every node to a header-only card by default", () => {
    // 테이블·뷰 모두 접힘이 기본 / tables and views both fold to the header
    const collapsedView = estimateNodeSize(makeNode("view", 10), false);
    const collapsedTable = estimateNodeSize(makeNode("table", 10), false);
    expect(collapsedView.height).toBeLessThan(60);
    expect(collapsedTable.height).toBe(collapsedView.height);
    const expanded = estimateNodeSize(makeNode("view", 10), true);
    expect(expanded.height).toBeGreaterThan(collapsedView.height);
  });

  it("caps visible rows and adds an overflow row when expanded", () => {
    const small = estimateNodeSize(makeNode("table", 10), true);
    const huge = estimateNodeSize(makeNode("table", 60), true);
    const capped = estimateNodeSize(makeNode("table", MAX_VISIBLE_COLUMNS + 1), true);
    expect(huge.height).toBe(capped.height); // 초과분은 한 줄 요약 / overflow collapses to one row
    expect(huge.height).toBeGreaterThan(small.height);
    expect(huge.width).toBe(NODE_WIDTH);
  });
});

describe("layoutGraph", () => {
  it("assigns deterministic positions with layered direction", async () => {
    const nodes = [
      { id: 1, width: 260, height: 100 },
      { id: 2, width: 260, height: 100 },
    ];
    const edges = [{
      id: "fk-1", kind: "fk" as const, src_object_id: 1, tgt_object_id: 2, columns: [],
    }];
    const a = await layoutGraph(nodes, edges);
    const b = await layoutGraph(nodes, edges);
    expect(a).toEqual(b); // 결정적 배치 — ELK 선정 근거 / deterministic placement
    const byId = new Map(a.map((p) => [p.id, p]));
    expect(byId.get(2)!.x).toBeGreaterThan(byId.get(1)!.x); // RIGHT 방향 계층
  });
});
