/** ELK layered 레이아웃 — 결정적 배치 (선정 근거: PROGRESS 정지점 6) / deterministic ELK layout. */

// bundled 빌드 사용 — 메인 엔트리는 optional 'web-worker' require로 번들이 깨진다
// the main entry's optional require('web-worker') breaks bundling
import ELK from "elkjs/lib/elk.bundled.js";

import type { GraphEdge, GraphNode } from "./types";

export const NODE_WIDTH = 260;
export const MAX_VISIBLE_COLUMNS = 24;
const HEADER_H = 36;
const ROW_H = 22;
const META_H = 26;

/** 노드 픽셀 크기 추정 — ELK 입력 / estimated pixel size fed to ELK. */
export function estimateNodeSize(
  node: GraphNode,
  viewExpanded: boolean,
): { width: number; height: number } {
  // 뷰는 기본 접힘(헤더만) / views collapse to the header by default
  if (node.type === "view" && !viewExpanded) {
    return { width: NODE_WIDTH, height: HEADER_H };
  }
  const rows = Math.min(node.columns.length, MAX_VISIBLE_COLUMNS)
    + (node.columns.length > MAX_VISIBLE_COLUMNS ? 1 : 0);
  return { width: NODE_WIDTH, height: HEADER_H + rows * ROW_H + META_H };
}

export interface PositionedNode {
  id: number;
  x: number;
  y: number;
}

export async function layoutGraph(
  nodes: { id: number; width: number; height: number }[],
  edges: GraphEdge[],
): Promise<PositionedNode[]> {
  const elk = new ELK();
  const result = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "80",
      "elk.spacing.nodeNode": "32",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    },
    children: nodes.map((n) => ({ id: String(n.id), width: n.width, height: n.height })),
    edges: edges.map((e) => ({
      id: e.id,
      sources: [String(e.src_object_id)],
      targets: [String(e.tgt_object_id)],
    })),
  });
  return (result.children ?? []).map((c) => ({
    id: Number(c.id),
    x: c.x ?? 0,
    y: c.y ?? 0,
  }));
}
