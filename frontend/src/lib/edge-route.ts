/** 간선 경로·라벨 위치 순수 계산 — ERD(직교 폴리라인)와 계보 맵(베지에) 공용.
 * / pure geometry for edge paths and label anchors, shared by the ERD and lineage maps. */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 모서리 반지름(px) — bpm 캔버스와 같은 5~6px가 "꺾임"을 잃지 않는 최대치 */
export const CORNER_RADIUS = 6;

/** 폴리라인 → 모서리를 둥글린 SVG path. 반지름은 이웃 변 길이의 절반으로 클램프해
 * 짧은 변에서 곡선이 서로 겹치지 않게 한다. */
export function buildRoundedPath(points: Point[], radius: number = CORNER_RADIUS): string {
  if (points.length < 2) return "";
  const parts = [`M${points[0].x},${points[0].y}`];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const corner = points[i];
    const next = points[i + 1];
    const inLen = Math.hypot(corner.x - prev.x, corner.y - prev.y);
    const outLen = Math.hypot(next.x - corner.x, next.y - corner.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r <= 0) continue;
    const inPoint = {
      x: corner.x - ((corner.x - prev.x) / inLen) * r,
      y: corner.y - ((corner.y - prev.y) / inLen) * r,
    };
    const outPoint = {
      x: corner.x + ((next.x - corner.x) / outLen) * r,
      y: corner.y + ((next.y - corner.y) / outLen) * r,
    };
    parts.push(`L${inPoint.x},${inPoint.y}`, `Q${corner.x},${corner.y} ${outPoint.x},${outPoint.y}`);
  }
  const last = points[points.length - 1];
  parts.push(`L${last.x},${last.y}`);
  return parts.join(" ");
}

/** 라벨 필 절반 크기(px) — 충돌 판정용 상한 (bpm edge-detour와 같은 값) */
const LABEL_HALF_W = 80;
const LABEL_HALF_H = 12;

function isBoxClear(center: Point, obstacles: Rect[]): boolean {
  return obstacles.every((r) =>
    center.x + LABEL_HALF_W <= r.x || center.x - LABEL_HALF_W >= r.x + r.width
    || center.y + LABEL_HALF_H <= r.y || center.y - LABEL_HALF_H >= r.y + r.height);
}

/** 라벨 앵커 — 노드 사각형과 겹치지 않는 구간 중 가장 긴 구간의 중점. 전부 막히면 가장 긴 구간.
 * 경로 중점을 쓰면 fan-in에서 정확히 가장 붐비는 세로 회랑 위에 앉는다 — 그래서 구간 단위로 고른다.
 * / midpoint of the longest segment whose label box clears every node; longest segment as fallback. */
export function pickLabelAnchor(route: Point[], obstacles: Rect[]): Point {
  let best: { mid: Point; length: number } | null = null;
  let longest: { mid: Point; length: number } | null = null;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1];
    const b = route[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (!longest || length > longest.length) longest = { mid, length };
    if (isBoxClear(mid, obstacles) && (!best || length > best.length)) best = { mid, length };
  }
  const chosen = best ?? longest;
  return chosen ? chosen.mid : { x: 0, y: 0 };
}

/** React Flow getBezierPath와 같은 제어점(가로 방향, curvature 0.25)의 3차 베지에 위 한 점.
 * 라벨을 중점(t=0.5)이 아닌 곳에 놓기 위해 직접 계산한다. */
export function getBezierPoint(
  sx: number, sy: number, tx: number, ty: number, t: number,
): Point {
  const distance = tx - sx;
  // @xyflow/system calculateControlOffset(distance, 0.25)
  const offset = distance >= 0 ? distance * 0.5 : 0.25 * 25 * Math.sqrt(-distance);
  const c1x = sx + offset;
  const c2x = tx - offset;
  const mt = 1 - t;
  return {
    x: mt * mt * mt * sx + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * tx,
    y: mt * mt * mt * sy + 3 * mt * mt * t * sy + 3 * mt * t * t * ty + t * t * t * ty,
  };
}

export interface LabelEdge {
  id: string;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  /** 어느 끝이 덜 붐비는가 — fan-in은 source, fan-out은 target */
  near: "source" | "target";
}

/** 라벨을 "덜 붐비는 끝" 쪽 t에 놓고, 같은 x 근방에서 세로로 붙는 라벨은 아래로 밀어낸다.
 * t=0.28/0.72인 이유: 그 지점에서는 곡선이 아직 끝점 간격(카드 높이+갭)만큼 떨어져 있어
 * 라벨이 카드 옆에 한 줄로 정렬된다. 중점(0.5)은 fan-in에서 y 간격이 반으로 준다. */
export function placeEdgeLabels(edges: LabelEdge[], minGap: number = 22): Map<string, Point> {
  const anchors = edges.map((edge) => ({
    id: edge.id,
    point: getBezierPoint(edge.sx, edge.sy, edge.tx, edge.ty, edge.near === "source" ? 0.28 : 0.72),
  }));
  // 가까운 x끼리 묶어 1차원 분리 — 다른 레인 갭의 라벨은 서로 간섭하지 않는다
  const buckets = new Map<number, typeof anchors>();
  for (const anchor of anchors) {
    const key = Math.round(anchor.point.x / 80);
    const bucket = buckets.get(key) ?? [];
    bucket.push(anchor);
    buckets.set(key, bucket);
  }
  const placed = new Map<string, Point>();
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => a.point.y - b.point.y);
    let floor = -Infinity;
    for (const anchor of bucket) {
      const y = Math.max(anchor.point.y, floor);
      placed.set(anchor.id, { x: anchor.point.x, y });
      floor = y + minGap;
    }
  }
  return placed;
}
