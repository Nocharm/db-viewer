/** ELK layered 레이아웃 — 결정적 배치 (선정 근거: PROGRESS 정지점 6) / deterministic ELK layout.
 *
 * 노드 좌표와 함께 ELK가 계산한 **직교 간선 경로**도 돌려준다. 예전엔 경로를 버리고 React Flow
 * smoothstep으로 다시 그렸는데, smoothstep은 항상 두 노드의 중간 x에서 꺾이므로 같은 두 레이어
 * 사이 간선이 전부 한 세로선에 겹쳤다(실측: 허브 fan-in이 "트렁크" 하나로 보임).
 * / node positions plus ELK's orthogonal edge routes — redrawing with smoothstep collapsed
 *   every edge between two layers onto one vertical trunk.
 */

// bundled 빌드 사용 — 메인 엔트리는 optional 'web-worker' require로 번들이 깨진다
// the main entry's optional require('web-worker') breaks bundling
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkExtendedEdge } from "elkjs/lib/elk-api";

import type { Point } from "./edge-route";
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

/** ELK가 그린 간선 폴리라인 — 시작·꺾임·끝점, 노드와 같은 좌표계 */
export interface EdgeRoute {
  id: string;
  points: Point[];
}

export interface LayoutResult {
  nodes: PositionedNode[];
  routes: EdgeRoute[];
}

export async function layoutGraph(
  nodes: { id: number; width: number; height: number }[],
  edges: GraphEdge[],
): Promise<LayoutResult> {
  const elk = new ELK();
  // 간선마다 자기 포트 — 포트를 공유하면 ELK가 같은 포트로 드는 간선을 하이퍼엣지로 묶어
  // 세로 회랑까지 하나로 합친다(실측). 포트가 다르면 회랑이 edgeEdge 간격으로 갈라진다.
  // / one port per edge end: shared ports make ELK merge the routes into a single corridor
  const ports = new Map<number, { id: string; side: "EAST" | "WEST" }[]>();
  const addPort = (nodeId: number, portId: string, side: "EAST" | "WEST") => {
    const list = ports.get(nodeId) ?? [];
    list.push({ id: portId, side });
    ports.set(nodeId, list);
  };
  const routable = edges.filter((e) => e.src_object_id !== e.tgt_object_id);
  for (const edge of routable) {
    addPort(edge.src_object_id, `${edge.id}:s`, "EAST");
    addPort(edge.tgt_object_id, `${edge.id}:t`, "WEST");
  }

  const result = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      // 레이어 간 96px 기본 — 라벨은 이제 소스 쪽 가로 구간에 앉으므로 라벨 폭에 묶이지 않는다.
      // fan-in이 많으면 ELK가 회랑 수만큼 스스로 더 벌린다
      // / 96px base; the orthogonal router widens the gap by the corridors it needs
      "elk.layered.spacing.nodeNodeBetweenLayers": "96",
      // 접힌 헤더(36px)에 맞춘 세로 리듬 — 44는 목록처럼 읽히기엔 성겼다
      "elk.spacing.nodeNode": "24",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.edgeNode": "24",
      "elk.spacing.edgeEdge": "12",
      "elk.layered.spacing.edgeNodeBetweenLayers": "24",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "12",
      // 1:1 체인은 직선으로 — 꺾임이 관계가 아니라 배치 사정으로 읽히는 것을 막는다
      "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
      "elk.layered.nodePlacement.favorStraightEdges": "true",
    },
    children: nodes.map((n) => ({
      id: String(n.id),
      width: n.width,
      height: n.height,
      layoutOptions: { "elk.portConstraints": "FIXED_SIDE" },
      ports: (ports.get(n.id) ?? []).map((port) => ({
        id: port.id, width: 1, height: 1,
        layoutOptions: { "elk.port.side": port.side },
      })),
    })),
    edges: routable.map((e) => ({
      id: e.id,
      sources: [`${e.id}:s`],
      targets: [`${e.id}:t`],
    })),
  });
  return {
    nodes: (result.children ?? []).map((c) => ({
      id: Number(c.id),
      x: c.x ?? 0,
      y: c.y ?? 0,
    })),
    // 반환 타입이 입력 리터럴로 좁혀진다 — 실제 결과는 sections를 가진 ElkExtendedEdge
    routes: ((result.edges ?? []) as ElkExtendedEdge[]).flatMap((edge) => {
      const section = edge.sections?.[0];
      if (!section) return [];
      return [{
        id: edge.id,
        points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint],
      }];
    }),
  };
}
