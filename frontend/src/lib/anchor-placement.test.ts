import { describe, expect, it } from "vitest";

import { placeAtPointer } from "./anchor-placement";

const W = 264;
const H = 150;
const VW = 1440;
const VH = 900;

describe("placeAtPointer", () => {
  it("여유가 있으면 포인터 우하단 +12에 선다", () => {
    expect(placeAtPointer(100, 100, W, H, VW, VH)).toEqual({
      left: 112, top: 112, flippedX: false, flippedY: false,
    });
  });

  it("오른쪽이 모자라면 포인터 왼쪽으로 반전한다 — 밀어 넣지 않는다", () => {
    const p = placeAtPointer(1400, 100, W, H, VW, VH);
    expect(p.flippedX).toBe(true);
    expect(p.left + W).toBe(1400 - 12);
    expect(p.top).toBe(112);
  });

  it("아래가 모자라면 포인터 위로 반전한다", () => {
    const p = placeAtPointer(100, 880, W, H, VW, VH);
    expect(p.flippedY).toBe(true);
    expect(p.top + H).toBe(880 - 12);
  });

  it("우하단 모서리는 양쪽 다 반전한다", () => {
    const p = placeAtPointer(1430, 890, W, H, VW, VH);
    expect(p).toMatchObject({ flippedX: true, flippedY: true });
    expect(p.left + W).toBeLessThan(1430);
    expect(p.top + H).toBeLessThan(890);
  });

  it("반전해도 안 들어가는 작은 뷰포트에서는 여백 안쪽으로만 붙인다", () => {
    const p = placeAtPointer(5, 5, W, H, 200, 100);
    expect(p.left).toBe(8);
    expect(p.top).toBe(8);
  });
});
