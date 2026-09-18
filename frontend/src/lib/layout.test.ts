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
    const byId = new Map(a.nodes.map((p) => [p.id, p]));
    expect(byId.get(2)!.x).toBeGreaterThan(byId.get(1)!.x); // RIGHT 방향 계층
  });

  it("returns one orthogonal route per edge, and fan-in edges get separate corridors", async () => {
    // 리프 4개 → 허브 1개. 예전 smoothstep은 전부 같은 x에서 꺾여 트렁크가 됐다
    const nodes = [1, 2, 3, 4, 5].map((id) => ({ id, width: 260, height: 36 }));
    const edges = [1, 2, 3, 4].map((src) => ({
      id: `fk-${src}`, kind: "fk" as const, src_object_id: src, tgt_object_id: 5, columns: [],
    }));
    const { routes } = await layoutGraph(nodes, edges);
    expect(routes.map((r) => r.id).sort()).toEqual(["fk-1", "fk-2", "fk-3", "fk-4"]);
    for (const route of routes) {
      expect(route.points.length).toBeGreaterThanOrEqual(2);
      // 직교: 이웃 점은 x 또는 y가 같다 / orthogonal legs
      for (let i = 1; i < route.points.length; i++) {
        const a = route.points[i - 1];
        const b = route.points[i];
        expect(a.x === b.x || a.y === b.y).toBe(true);
      }
    }
    // 세로 구간을 가진 간선끼리 y 범위가 겹치면 x가 달라야 한다 (회랑 분리)
    const verticals = routes.flatMap((r) => {
      const legs: { x: number; y0: number; y1: number }[] = [];
      for (let i = 1; i < r.points.length; i++) {
        const a = r.points[i - 1];
        const b = r.points[i];
        if (a.x === b.x) legs.push({ x: a.x, y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) });
      }
      return legs;
    });
    for (let i = 0; i < verticals.length; i++) {
      for (let j = i + 1; j < verticals.length; j++) {
        const overlap = verticals[i].y0 < verticals[j].y1 && verticals[j].y0 < verticals[i].y1;
        if (overlap) expect(verticals[i].x).not.toBe(verticals[j].x);
      }
    }
  });

  it("skips self-loops instead of asking ELK to route them", async () => {
    const nodes = [{ id: 1, width: 260, height: 36 }];
    const edges = [{
      id: "self", kind: "fk" as const, src_object_id: 1, tgt_object_id: 1, columns: [],
    }];
    const { routes } = await layoutGraph(nodes, edges);
    expect(routes).toEqual([]);
  });
});
