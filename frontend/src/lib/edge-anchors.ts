/** 엣지 → 컬럼 행 핸들 해석 — 펼친 노드만 컬럼에 붙는다. / resolve column-row edge handles. */

import type { GraphEdge } from "./types";

/** 컬럼 페어를 갖는 엣지 종류 / edge kinds that carry a column pair. */
export const PAIR_KINDS = new Set(["fk", "inferred", "confirmed", "ai_suggested"]);

export interface NodeAnchorInfo {
  expanded: boolean;
  /** 화면에 실제 렌더되는 컬럼(표시 상한 이내) / columns actually rendered */
  visibleColumns: Set<string>;
}

export interface EdgeHandles {
  sourceHandle?: string;
  targetHandle?: string;
}

/** 소스는 우측(s-), 타깃은 좌측(t-) 핸들 — 접힘·상한 초과 컬럼은 헤더 연결로 폴백.
 * Falls back to the default header handle when folded or the column is cut off. */
export function resolveEdgeHandles(
  edge: GraphEdge,
  src: NodeAnchorInfo | undefined,
  tgt: NodeAnchorInfo | undefined,
): EdgeHandles {
  if (!PAIR_KINDS.has(edge.kind) || !Array.isArray(edge.columns) || edge.columns.length === 0) {
    return {};
  }
  const pair = edge.columns[0] as { src_column?: string; tgt_column?: string };
  const handles: EdgeHandles = {};
  if (pair.src_column && src?.expanded && src.visibleColumns.has(pair.src_column)) {
    handles.sourceHandle = `s-${pair.src_column}`;
  }
  if (pair.tgt_column && tgt?.expanded && tgt.visibleColumns.has(pair.tgt_column)) {
    handles.targetHandle = `t-${pair.tgt_column}`;
  }
  return handles;
}
