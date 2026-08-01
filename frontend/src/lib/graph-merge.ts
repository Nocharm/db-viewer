/** 앵커 확장 그래프 병합 + 렌더 임계치 판단 / graph merging and render-threshold checks. */

import type { GraphResponse } from "./types";

/** 이 수를 넘는 렌더링은 확인 모달을 거친다 (계획 §1.5) / confirm-before-render threshold. */
export const NODE_CONFIRM_THRESHOLD = 40;

export function mergeGraphs(
  current: GraphResponse | null,
  incoming: GraphResponse,
): GraphResponse {
  if (!current) return incoming;
  const nodes = new Map(current.nodes.map((n) => [n.id, n]));
  for (const n of incoming.nodes) nodes.set(n.id, n);
  const edges = new Map(current.edges.map((e) => [e.id, e]));
  for (const e of incoming.edges) edges.set(e.id, e);
  return {
    ...current,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
  };
}

export interface MergePlan {
  merged: GraphResponse;
  addedCount: number;
  total: number;
  needsConfirm: boolean;
}

export function planMerge(
  current: GraphResponse | null,
  incoming: GraphResponse,
): MergePlan {
  const merged = mergeGraphs(current, incoming);
  const before = current?.nodes.length ?? 0;
  const total = merged.nodes.length;
  return {
    merged,
    addedCount: total - before,
    total,
    // 이미 임계치를 넘겨 그려진 상태에서의 소폭 확장은 다시 묻지 않는다
    // once past the threshold, only re-confirm when the expansion crosses it anew
    needsConfirm: total > NODE_CONFIRM_THRESHOLD && before <= NODE_CONFIRM_THRESHOLD,
  };
}
