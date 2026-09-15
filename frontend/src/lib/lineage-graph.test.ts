import { describe, expect, it } from "vitest";

import type { LineageNodeData } from "@/lib/api";
import {
  assignColumnLineageLanes, assignImpactLanes, assignSourceFlowLanes,
  EXPANDED_MAX_NODE_HEIGHT, layoutLanes, LANE_GAP, MAX_NODE_HEIGHT, measureNodeHeight,
  NODE_WIDTH,
} from "@/lib/lineage-graph";

function node(qname: string, depth: number, columns: string[] = []): LineageNodeData {
  return {
    id: 1, qname, schema: "dbo", type: "table", depth, direct: true, row_count: null,
    column_count: columns.length, ai_summary: null, hidden: false, columns,
  };
}

describe("measureNodeHeight", () => {
  it("컬럼이 없으면 헤더 높이만 쓴다", () => {
    expect(measureNodeHeight(0)).toBeLessThan(measureNodeHeight(1));
  });

  it("컬럼이 아무리 많아도 상한을 넘지 않는다 — 넘으면 카드가 화면을 삼킨다", () => {
    expect(measureNodeHeight(400)).toBe(MAX_NODE_HEIGHT);
    expect(measureNodeHeight(400, true)).toBe(EXPANDED_MAX_NODE_HEIGHT);
  });

  it("펼치면 같은 행 수라도 더 높아질 수 있다 — 미사용 컬럼이 들어갈 자리", () => {
    expect(measureNodeHeight(30, true)).toBeGreaterThan(measureNodeHeight(30, false));
  });
});

describe("layoutLanes", () => {
  it("레인 번호가 곧 가로 위치다", () => {
    const placed = layoutLanes([
      { key: "a", lane: 0, rowCount: 0 },
      { key: "b", lane: 2, rowCount: 0 },
    ]);
    const [a, b] = placed;
    // 레인 0과 2 사이에 빈 레인이 없어도 순서만 유지하면 된다(연속 배치)
    expect(a.x).toBe(0);
    expect(b.x).toBe(NODE_WIDTH + LANE_GAP);
  });

  it("같은 레인 노드는 겹치지 않는다", () => {
    const placed = layoutLanes([
      { key: "a", lane: 0, rowCount: 3 },
      { key: "b", lane: 0, rowCount: 1 },
    ]);
    const [a, b] = placed;
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
  });

  it("짧은 레인은 긴 레인 기준 가운데로 온다", () => {
    const placed = layoutLanes([
      { key: "tall1", lane: 0, rowCount: 5 },
      { key: "tall2", lane: 0, rowCount: 5 },
      { key: "short", lane: 1, rowCount: 0 },
    ]);
    const short = placed.find((p) => p.key === "short")!;
    const laneTop = Math.min(...placed.filter((p) => p.lane === 0).map((p) => p.y));
    const laneBottom = Math.max(
      ...placed.filter((p) => p.lane === 0).map((p) => p.y + p.height));
    const shortCenter = short.y + short.height / 2;
    expect(shortCenter).toBeCloseTo((laneTop + laneBottom) / 2, 0);
  });

  it("노드를 펼치면 같은 레인의 아래 노드가 자동으로 밀려난다", () => {
    const collapsed = layoutLanes([
      { key: "a", lane: 0, rowCount: 3 },
      { key: "b", lane: 0, rowCount: 3 },
    ]);
    const opened = layoutLanes([
      { key: "a", lane: 0, rowCount: 20, expanded: true },
      { key: "b", lane: 0, rowCount: 3 },
    ]);
    const bBefore = collapsed.find((p) => p.key === "b")!;
    const bAfter = opened.find((p) => p.key === "b")!;
    const aAfter = opened.find((p) => p.key === "a")!;
    expect(bAfter.y - aAfter.y).toBeGreaterThan(bBefore.y - collapsed[0].y);
    expect(bAfter.y).toBeGreaterThanOrEqual(aAfter.y + aAfter.height);
  });

  it("빈 입력에도 터지지 않는다", () => {
    expect(layoutLanes([])).toEqual([]);
  });
});

describe("레인 배정", () => {
  it("소스 흐름은 소스 전부가 왼쪽, 뷰가 오른쪽", () => {
    const items = assignSourceFlowLanes([node("dbo.A", 1), node("dbo.B", 1)], "dbo.V");
    expect(items.filter((i) => i.lane === 0).map((i) => i.key)).toEqual(["dbo.A", "dbo.B"]);
    expect(items.find((i) => i.key === "dbo.V")?.lane).toBe(1);
  });

  it("컬럼 계보는 depth가 깊을수록 왼쪽이고 뷰가 맨 오른쪽", () => {
    const items = assignColumnLineageLanes(
      [node("dbo.DEEP", 2), node("dbo.NEAR", 1)], "dbo.V", 4);
    const deep = items.find((i) => i.key === "dbo.DEEP")!;
    const near = items.find((i) => i.key === "dbo.NEAR")!;
    const view = items.find((i) => i.key === "dbo.V")!;
    expect(deep.lane).toBeLessThan(near.lane);
    expect(view.lane).toBeGreaterThan(near.lane);
    expect(view.rowCount).toBe(4);
  });

  it("영향도는 depth가 곧 레인 — 루트가 0", () => {
    const items = assignImpactLanes([node("dbo.ROOT", 0), node("dbo.V1", 1)]);
    expect(items.map((i) => i.lane)).toEqual([0, 1]);
  });
});
