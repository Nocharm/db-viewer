/** 연결요소 그룹핑 + 수동 배치 병합 — 클러스터 정렬·좌표 순수 로직. */

import type { GraphEdge, GraphNode } from "./types";

export function groupConnectedComponents(
  nodes: GraphNode[], edges: GraphEdge[],
): GraphNode[][] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    parent.set(x, root);
    return root;
  };
  for (const n of nodes) parent.set(n.id, n.id);
  for (const e of edges) {
    // 그래프에 없는 노드를 참조하는 엣지는 무시 — 그룹핑 대상이 아님
    if (!parent.has(e.src_object_id) || !parent.has(e.tgt_object_id)) continue;
    const a = find(e.src_object_id);
    const b = find(e.tgt_object_id);
    if (a !== b) parent.set(a, b);
  }

  const byRoot = new Map<number, GraphNode[]>();
  for (const n of nodes) {
    const root = find(n.id);
    const group = byRoot.get(root) ?? [];
    group.push(n);
    byRoot.set(root, group);
  }
  return [...byRoot.values()].sort((g1, g2) =>
    g2.length - g1.length
    || Math.min(...g1.map((n) => n.id)) - Math.min(...g2.map((n) => n.id)));
}

/** 그룹 바운딩박스 — 패킹 입력 / a laid-out component's bounding box. */
export interface GroupBox {
  width: number;
  height: number;
}

/** 연결요소 그룹의 배치 원점 — 그룹 내 좌표에 더해진다 / per-group placement origin. */
export interface GroupOffset {
  x: number;
  y: number;
}

/** 그룹들을 뷰포트 비율에 가까운 행으로 패킹한다 — 세로 일렬 적층은 전체 그래프를
 * 좁고 긴 스트립으로 만들어 초기 fitView 스케일을 minZoom(0.1)까지 떨어뜨렸다(실측).
 * 입력 순서 보존(큰 그룹 우선 정렬은 호출부 책임), 결정적.
 * / packs component boxes into rows near the target aspect; the old single-column stack
 *   collapsed the initial fitView to minZoom. Order-preserving and deterministic. */
export function packGroupRows(
  boxes: GroupBox[], gap: number, targetAspect = 1.7,
): GroupOffset[] {
  // 목표 폭 = 전체 면적을 목표 비율 직사각형에 담을 때의 폭 — 가장 넓은 그룹이
  // 잘리지 않게 하한으로 클램프한다
  const totalArea = boxes.reduce(
    (acc, box) => acc + (box.width + gap) * (box.height + gap), 0);
  const widest = boxes.reduce((acc, box) => Math.max(acc, box.width), 0);
  const targetWidth = Math.max(widest, Math.sqrt(totalArea * targetAspect));

  const offsets: GroupOffset[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const box of boxes) {
    if (x > 0 && x + box.width > targetWidth) {
      x = 0;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    offsets.push({ x, y });
    x += box.width + gap;
    rowHeight = Math.max(rowHeight, box.height);
  }
  return offsets;
}

/** ELK 배치 좌표 + 추정 크기 — ErdViewer의 배치 기록 단위 */
export interface PlacedNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** ELK 배치 결과에 수동 이동 좌표를 덮어쓴다 — 크기는 ELK 측정값 유지.
 * 그래프에서 사라진 노드의 수동 좌표는 무시한다. */
export function applyManualPositions(
  placed: Map<number, PlacedNode>,
  moved: Map<number, { x: number; y: number }>,
): Map<number, PlacedNode> {
  const merged = new Map(placed);
  for (const [id, position] of moved) {
    const base = merged.get(id);
    if (!base) continue;
    merged.set(id, { ...base, x: position.x, y: position.y });
  }
  return merged;
}
