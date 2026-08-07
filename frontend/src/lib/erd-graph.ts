/** 읽기 전용 ERD의 연결요소 그룹핑 — 클러스터 정렬용 순수 로직. */

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
