/** ELK layered 레이아웃 — 결정적 배치 (선정 근거: PROGRESS 정지점 6) / deterministic ELK layout. */

// bundled 빌드 사용 — 메인 엔트리는 optional 'web-worker' require로 번들이 깨진다
// the main entry's optional require('web-worker') breaks bundling
import ELK from "elkjs/lib/elk.bundled.js";

import type { GraphEdge, GraphNode } from "./types";

export const NODE_WIDTH = 260;
/** 노드 카드 최대 높이(px) — 넘는 컬럼은 노드 내부 스크롤로 본다.
 * ELK 입력과 실제 렌더가 같은 상한을 써야 배치가 어긋나지 않는다. */
export const MAX_NODE_HEIGHT = 520;
const HEADER_H = 36;
const ROW_H = 22;
const META_H = 26;

/** 노드 픽셀 크기 추정 — ELK 입력 / estimated pixel size fed to ELK. */
export function estimateNodeSize(
  node: GraphNode,
  expanded: boolean,
): { width: number; height: number } {
  // 모든 노드 기본 접힘(헤더만) — 원하는 것만 선택적으로 펼친다 / every node folds to its header
  if (!expanded) {
    return { width: NODE_WIDTH, height: HEADER_H };
  }
  const natural = HEADER_H + node.columns.length * ROW_H + META_H;
  return { width: NODE_WIDTH, height: Math.min(natural, MAX_NODE_HEIGHT) };
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
      // 꺾은선(React Flow smoothstep)이 지날 회랑을 확보하는 건 아래 spacing 둘이다.
      // edgeRouting은 layered의 기본값이라 실측상 배치를 바꾸지 않지만, 이 배치가 직교
      // 라우팅을 전제한다는 의도를 명시로 남긴다 / the two spacings are what actually
      // reserve the corridor; edgeRouting is layered's default and measured as a no-op
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.edgeNode": "24",
      "elk.spacing.edgeEdge": "12",
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
