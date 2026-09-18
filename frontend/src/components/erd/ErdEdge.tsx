"use client";

/** ERD 간선 — ELK가 계산한 직교 경로를 그대로 그린다.
 *
 * 경로가 없을 때(드래그로 옮긴 노드에 붙은 간선)만 React Flow smoothstep으로 폴백한다.
 * 라벨은 HTML(EdgeLabelRenderer) — 노드에 안 겹치는 구간에 앉히려면 좌표를 직접 줘야 한다.
 * / draws ELK's orthogonal route; smoothstep only for edges whose end was dragged. */

import {
  BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps,
} from "@xyflow/react";

import { buildRoundedPath, CORNER_RADIUS, type Point } from "@/lib/edge-route";

export interface ErdEdgeData extends Record<string, unknown> {
  /** ELK 경로 — 양 끝 노드가 배치 위치에 있을 때만 유효 */
  route?: Point[];
  /** 호버 중인 간선에만 실린다 */
  label?: string;
  labelAnchor?: Point;
  hot?: boolean;
}

export function ErdEdge({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  style, markerStart, markerEnd, data,
}: EdgeProps) {
  const edgeData = (data ?? {}) as ErdEdgeData;
  const route = edgeData.route;
  let path: string;
  let labelX: number;
  let labelY: number;
  if (route && route.length >= 2) {
    path = buildRoundedPath(route);
    const mid = route[Math.floor(route.length / 2)];
    labelX = edgeData.labelAnchor?.x ?? mid.x;
    labelY = edgeData.labelAnchor?.y ?? mid.y;
  } else {
    [path, labelX, labelY] = getSmoothStepPath({
      sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
      borderRadius: CORNER_RADIUS,
    });
  }

  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerStart={markerStart} markerEnd={markerEnd} />
      {edgeData.label && (
        <EdgeLabelRenderer>
          <div
            className="edge-label edge-label--hot nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            data-testid={`ErdEdge-label-${id}`}
          >
            {edgeData.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
