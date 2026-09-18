import { describe, expect, it } from "vitest";

import {
  buildRoundedPath, getBezierPoint, pickLabelAnchor, placeEdgeLabels,
} from "./edge-route";

describe("buildRoundedPath", () => {
  it("직선 두 점은 M·L 하나로 끝난다", () => {
    expect(buildRoundedPath([{ x: 0, y: 10 }, { x: 100, y: 10 }])).toBe("M0,10 L100,10");
  });

  it("꺾이는 점마다 둥근 모서리(Q)를 넣는다 — 모서리 반지름은 짧은 변의 절반을 넘지 않는다", () => {
    const d = buildRoundedPath([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 100 }], 6);
    // 첫 변이 4px라 반지름은 2로 줄어든다 / the 4px leg caps the radius at 2
    expect(d).toBe("M0,0 L2,0 Q4,0 4,2 L4,100");
  });

  it("점이 하나뿐이면 빈 경로", () => {
    expect(buildRoundedPath([{ x: 3, y: 3 }])).toBe("");
  });
});

describe("pickLabelAnchor", () => {
  const route = [
    { x: 0, y: 50 }, { x: 40, y: 50 }, { x: 40, y: 250 }, { x: 300, y: 250 },
  ];

  it("노드에 안 겹치는 구간 중 가장 긴 구간의 중점을 고른다", () => {
    // 마지막 가로 구간(260px)이 가장 길지만 그 중점(170,250)에 노드가 있다
    const anchor = pickLabelAnchor(route, [{ x: 120, y: 230, width: 100, height: 40 }]);
    expect(anchor).toEqual({ x: 40, y: 150 });
  });

  it("전부 막혀 있으면 가장 긴 구간으로 폴백한다", () => {
    const anchor = pickLabelAnchor(route, [
      { x: 120, y: 230, width: 100, height: 40 },
      { x: 0, y: 100, width: 100, height: 100 },
      { x: 0, y: 40, width: 60, height: 20 },
    ]);
    expect(anchor).toEqual({ x: 170, y: 250 });
  });
});

describe("getBezierPoint", () => {
  it("t=0·1은 양 끝점, t=0.5는 y 중간", () => {
    expect(getBezierPoint(0, 0, 200, 100, 0)).toEqual({ x: 0, y: 0 });
    expect(getBezierPoint(0, 0, 200, 100, 1)).toEqual({ x: 200, y: 100 });
    expect(getBezierPoint(0, 0, 200, 100, 0.5).y).toBeCloseTo(50);
  });
});

describe("placeEdgeLabels", () => {
  // 6개 소스가 한 뷰로 모이는 fan-in — 소스 y 간격 60
  const fanIn = Array.from({ length: 6 }, (_, i) => ({
    id: `e${i}`, sx: 236, sy: 30 + i * 60, tx: 434, ty: 180, near: "source" as const,
  }));

  it("fan-in 라벨은 소스 쪽에 앉아 서로 22px 이상 떨어진다", () => {
    const placed = placeEdgeLabels(fanIn);
    const ys = fanIn.map((e) => placed.get(e.id)!.y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(22);
    // 소스 쪽: x가 중점보다 소스에 가깝다
    expect(placed.get("e0")!.x).toBeLessThan((236 + 434) / 2);
  });

  it("fan-out 라벨은 목표 쪽에 앉는다", () => {
    const placed = placeEdgeLabels([{ id: "a", sx: 0, sy: 0, tx: 200, ty: 100, near: "target" }]);
    expect(placed.get("a")!.x).toBeGreaterThan(100);
  });

  it("빽빽하게 겹치는 라벨은 아래로 밀려 최소 간격을 지킨다", () => {
    const dense = Array.from({ length: 4 }, (_, i) => ({
      id: `d${i}`, sx: 0, sy: 10 + i * 8, tx: 300, ty: 100, near: "source" as const,
    }));
    const placed = placeEdgeLabels(dense, 22);
    const ys = dense.map((e) => placed.get(e.id)!.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(22);
  });
});
