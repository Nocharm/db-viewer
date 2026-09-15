"use client";

/** 계보 맵의 간선 — 라벨을 HTML로 그린다.
 *
 * React Flow 기본 라벨은 SVG `<text>`라 줄바꿈이 안 되고, 긴 조인 조건이 한 줄로 뻗어
 * 양쪽 노드 카드를 덮는다. `EdgeLabelRenderer`로 HTML 라벨을 띄우면 줄바꿈·폭 제한·클릭이
 * 전부 된다 — 라벨은 관계 정보를 여는 버튼이기도 하다.
 * / HTML labels via EdgeLabelRenderer: wrapping, a width cap, and a clickable affordance.
 */

import {
  BaseEdge, EdgeLabelRenderer, getBezierPath, getSmoothStepPath, type EdgeProps,
} from "@xyflow/react";

/** 간선 라벨 클릭으로 열리는 관계 정보 — 모달이 그대로 받아 그린다 */
export interface EdgeDetail {
  kind: "source" | "join" | "impact";
  title: string;
  rows: { label: string; value: string }[];
  /** 이 관계에 실린 컬럼들 — 칩으로 나열한다 */
  columns: string[];
  note?: string;
}

export interface LineageEdgeData extends Record<string, unknown> {
  label?: string;
  detail?: EdgeDetail;
  onOpenDetail?: (detail: EdgeDetail) => void;
  /** 조인 간선은 같은 레인의 위아래를 잇는다 — 베지에면 카드 위를 되감아 지나간다 */
  routing?: "bezier" | "smoothstep";
}

export function LineageEdge({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  style, markerEnd, data,
}: EdgeProps) {
  const edgeData = (data ?? {}) as LineageEdgeData;
  const params = {
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  };
  const [path, labelX, labelY] = edgeData.routing === "smoothstep"
    ? getSmoothStepPath({ ...params, borderRadius: 10 })
    : getBezierPath(params);

  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {edgeData.label && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="lineage-edge-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onClick={(event) => {
              event.stopPropagation();
              if (edgeData.detail) edgeData.onOpenDetail?.(edgeData.detail);
            }}
            title={edgeData.detail ? "관계 정보 보기" : undefined}
            data-testid={`LineageEdge-label-${id}`}
          >
            {edgeData.label}
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
