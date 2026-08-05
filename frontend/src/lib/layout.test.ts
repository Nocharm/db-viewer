import { describe, expect, it } from "vitest";

import { MAX_NODE_HEIGHT, NODE_WIDTH, estimateNodeSize, layoutGraph } from "./layout";
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

  it("caps expanded node height so ELK does not reserve unbounded space", () => {
    // 컬럼 500개 테이블도 상한을 넘지 않는다 — 넘으면 배치가 화면 밖으로 벌어진다
    const huge = estimateNodeSize(makeNode("table", 500), true);
    expect(huge.height).toBe(MAX_NODE_HEIGHT);
    expect(huge.width).toBe(NODE_WIDTH);
  });

  it("still grows with column count below the cap", () => {
    const small = estimateNodeSize(makeNode("table", 5), true);
    const larger = estimateNodeSize(makeNode("table", 15), true);
    expect(larger.height).toBeGreaterThan(small.height);
    expect(larger.height).toBeLessThanOrEqual(MAX_NODE_HEIGHT);
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
