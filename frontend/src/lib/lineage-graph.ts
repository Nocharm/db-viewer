/** 계보 맵의 레인 배치 — depth가 가로 위치다. / lane layout for the lineage maps: depth is x.
 *
 * ERD(`layout.ts`)는 ELK로 임의 그래프를 푸는 반면 계보 맵의 배치는 이미 정해져 있다 —
 * 노드마다 lane(=depth)이 붙어 오므로 세로로 쌓기만 하면 된다. 결정적이고 비동기가 없어
 * 탭을 오갈 때 노드가 튀지 않는다.
 * / lanes come pre-assigned, so this is a deterministic synchronous stack — no solver.
 */

import type { LineageNodeData } from "@/lib/api";

/** 레인 사이 간격(px) — 간선 라벨(조인 조건)이 들어갈 폭 */
export const LANE_GAP = 150;
export const NODE_WIDTH = 236;
/** 같은 레인 안 노드 세로 간격(px) */
export const NODE_GAP = 20;
/** 소스 흐름 레인 간격 — JOIN 조건 라벨이 두 카드 사이에 앉으므로 라벨 높이만큼 더 벌린다
 * (좁히면 라벨이 아래 카드 머리를 덮는다 — 브라우저 실측으로 잡힌 값) */
export const JOIN_LANE_GAP = 46;

const HEADER_HEIGHT = 48;
const COLUMN_ROW_HEIGHT = 20;
const COLUMNS_PADDING = 10;
/** 접힌 노드 카드 최대 높이(px) — 넘는 컬럼은 노드 안에서 스크롤한다 */
export const MAX_NODE_HEIGHT = 260;
/** 펼친 노드 최대 높이 — 미사용 컬럼까지 나오므로 더 준다. 그래도 상한은 둔다:
 * 200컬럼 테이블을 통째로 세우면 한 카드가 캔버스를 삼킨다 */
export const EXPANDED_MAX_NODE_HEIGHT = 420;

export interface LaneItem {
  key: string;
  lane: number;
  /** 카드 안에 그릴 컬럼 행 수 — 높이를 정한다 */
  rowCount: number;
  /** 펼친 노드인가 — 높이 상한이 커지고, 그만큼 같은 레인의 아래 노드가 밀려난다 */
  expanded?: boolean;
}

export interface PlacedNode extends LaneItem {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 컬럼 행 수 → 카드 높이(px). ELK 입력이 아니라 실제 렌더 높이와 같은 값이어야 한다.
 * 이 값이 레인 패킹의 입력이라, 펼침으로 행이 늘면 아래 노드들이 자동으로 밀려난다. */
export function measureNodeHeight(rowCount: number, expanded = false): number {
  if (rowCount <= 0) return HEADER_HEIGHT;
  const natural = HEADER_HEIGHT + COLUMNS_PADDING + rowCount * COLUMN_ROW_HEIGHT;
  return Math.min(natural, expanded ? EXPANDED_MAX_NODE_HEIGHT : MAX_NODE_HEIGHT);
}

/** 레인별로 세로로 쌓고, 각 레인을 전체 높이 기준 가운데 정렬한다.
 * 가운데 정렬을 하는 이유: 레인마다 노드 수가 크게 다를 때(테이블 1개 ↔ 뷰 12개) 위쪽
 * 정렬이면 짧은 레인이 화면 구석에 붙어 어느 레인과 짝인지 읽히지 않는다. */
export function layoutLanes(items: LaneItem[], gap: number = NODE_GAP): PlacedNode[] {
  if (items.length === 0) return [];
  const byLane = new Map<number, LaneItem[]>();
  for (const item of items) {
    const bucket = byLane.get(item.lane);
    if (bucket) bucket.push(item);
    else byLane.set(item.lane, [item]);
  }

  const laneHeights = new Map<number, number>();
  for (const [lane, bucket] of byLane) {
    const total = bucket.reduce(
      (sum, item) => sum + measureNodeHeight(item.rowCount, item.expanded), 0)
      + gap * (bucket.length - 1);
    laneHeights.set(lane, total);
  }
  const tallest = Math.max(...laneHeights.values());

  const lanes = [...byLane.keys()].sort((a, b) => a - b);
  const laneX = new Map<number, number>();
  lanes.forEach((lane, index) => laneX.set(lane, index * (NODE_WIDTH + LANE_GAP)));

  const placed: PlacedNode[] = [];
  for (const lane of lanes) {
    const bucket = byLane.get(lane) ?? [];
    let y = (tallest - (laneHeights.get(lane) ?? 0)) / 2;
    for (const item of bucket) {
      const height = measureNodeHeight(item.rowCount, item.expanded);
      placed.push({ ...item, x: laneX.get(lane) ?? 0, y, width: NODE_WIDTH, height });
      y += height + gap;
    }
  }
  return placed;
}

/** 노드 하나가 실제로 그릴 행 수와 펼침 여부 — 호출부가 펼침 상태를 알고 있다.
 * 레이아웃과 렌더가 같은 계산을 써야 카드가 잘리거나 겹치지 않는다. */
export type RowCountResolver = (node: LineageNodeData) => {
  rowCount: number;
  expanded: boolean;
};

const COLLAPSED: RowCountResolver = (node) => ({
  rowCount: node.columns.length, expanded: false,
});

/** 소스 흐름(탭1) 레인 — 직접 소스는 전부 1-hop이므로 두 레인이면 끝난다. */
export function assignSourceFlowLanes(
  nodes: LineageNodeData[],
  viewKey: string,
  rows: RowCountResolver = COLLAPSED,
): LaneItem[] {
  const items: LaneItem[] = nodes.map((node) => ({
    key: node.qname, lane: 0, ...rows(node),
  }));
  items.push({ key: viewKey, lane: 1, rowCount: 0 });
  return items;
}

/** 컬럼 계보(탭2) 레인 — 왼쪽으로 갈수록 depth가 깊다(base에 가깝다).
 * 뷰 자신은 depth 0이므로 항상 맨 오른쪽 레인에 선다. */
export function assignColumnLineageLanes(
  nodes: LineageNodeData[],
  viewKey: string,
  viewRowCount: number,
  rows: RowCountResolver = COLLAPSED,
): LaneItem[] {
  const maxDepth = nodes.reduce((max, node) => Math.max(max, node.depth), 1);
  const items: LaneItem[] = nodes.map((node) => ({
    key: node.qname,
    lane: maxDepth - node.depth,
    ...rows(node),
  }));
  items.push({ key: viewKey, lane: maxDepth, rowCount: viewRowCount });
  return items;
}

/** 영향도(탭4) 레인 — depth가 곧 레인. 루트가 0번. */
export function assignImpactLanes(
  nodes: LineageNodeData[], rows: RowCountResolver = COLLAPSED,
): LaneItem[] {
  return nodes.map((node) => ({ key: node.qname, lane: node.depth, ...rows(node) }));
}
