"use client";

/** 읽기 전용 ERD — 확정된 관계 전체를 연결요소별로 적층해 보여준다.
 * Read-only whole-graph ERD; connected components are laid out and stacked top-down. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Background, Controls, ReactFlow, ReactFlowProvider, useReactFlow,
} from "@xyflow/react";
import type { Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { CloseIcon } from "@/components/icons";
import { useI18n } from "@/components/i18n";
import { CardinalityMarkerDefs } from "@/components/erd/CardinalityMarkers";
import { fetchErdGraph } from "@/lib/api";
import {
  getCardinalityEnds, getEdgeGrade, getEdgeVisual, MARKER_ID, type EdgeGrade,
} from "@/lib/edge-style";
import { groupConnectedComponents } from "@/lib/erd-graph";
import type { MessageKey } from "@/lib/i18n";
import { estimateNodeSize, layoutGraph } from "@/lib/layout";
import type { ErdResponse, GraphEdge, GraphNode } from "@/lib/types";
import { Legend } from "./Legend";
import { TableNode, type TableFlowNode } from "./TableNode";

const nodeTypes = { tableNode: TableNode };

/** 연결요소 사이 세로 간격(px) — 그룹 경계를 알아보게 하는 유일한 단서라 여백이 넉넉해야 한다 */
const GROUP_GAP = 120;

/** 엣지 등급 → 범례와 같은 문구 / edge grade to the same wording the legend uses */
const GRADE_LABEL: Record<EdgeGrade, MessageKey> = {
  confirmed: "erd.legendConfirmed",
  inferred: "erd.legendInferredGrade",
  unresolved: "erd.legendUnresolvedGrade",
  lineage: "erd.legendLineageGrade",
};

interface PlacedNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 컬럼 페어만 추린다 — /api/erd는 fk·confirmed만 주므로 실질적으로 전량이다.
 * GraphEdge.columns is a union; view lineage carries plain strings. */
function getColumnPairs(edge: GraphEdge): { src_column: string; tgt_column: string }[] {
  return edge.columns.filter(
    (c): c is { src_column: string; tgt_column: string } => typeof c !== "string");
}

/** 연결요소별로 ELK를 독립 실행해 세로로 적층한다 — 한 번에 돌리면 ELK가 무관한 그룹을
 * 같은 레이어에 섞어 배치가 뒤엉킨다 / one ELK run per component, stacked vertically. */
async function layoutGroups(
  groups: GraphNode[][],
  edges: GraphEdge[],
  expandedNodes: Set<number>,
): Promise<Map<number, PlacedNode>> {
  const laid = await Promise.all(groups.map(async (group) => {
    const ids = new Set(group.map((n) => n.id));
    const sized = group.map((n) => ({
      id: n.id,
      ...estimateNodeSize(n, expandedNodes.has(n.id)),
    }));
    const groupEdges = edges.filter(
      (e) => ids.has(e.src_object_id) && ids.has(e.tgt_object_id));
    return { sized, positions: await layoutGraph(sized, groupEdges) };
  }));

  const placed = new Map<number, PlacedNode>();
  let offsetY = 0;
  for (const { sized, positions } of laid) {
    const sizeById = new Map(sized.map((s) => [s.id, s]));
    let bottom = 0;
    for (const position of positions) {
      const size = sizeById.get(position.id);
      if (!size) continue;
      placed.set(position.id, {
        x: position.x, y: position.y + offsetY,
        width: size.width, height: size.height,
      });
      bottom = Math.max(bottom, position.y + size.height);
    }
    offsetY += bottom + GROUP_GAP;
  }
  return placed;
}

interface Props {
  /** ?focus= 로 들어온 대상 — 그래프에 있으면 센터링, 없으면 배너 */
  focusId: number | null;
  focusLabel: string | null;
}

export function ErdViewer(props: Props) {
  return (
    <ReactFlowProvider>
      <ErdViewerInner {...props} />
    </ReactFlowProvider>
  );
}

function ErdViewerInner({ focusId, focusLabel }: Props) {
  const { t } = useI18n();
  const [graph, setGraph] = useState<ErdResponse | null>(null);
  // 모든 노드 기본 접힘 — 보고 싶은 것만 펼친다 / everything folds to its header
  const [expandedNodes, setExpandedNodes] = useState<Set<number>>(new Set());
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [flowNodes, setFlowNodes] = useState<TableFlowNode[]>([]);
  const [flowEdges, setFlowEdges] = useState<Edge[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { setCenter } = useReactFlow();
  // fresh 마운트에선 ReactFlow 초기화 전 setCenter가 무시된다 — onInit까지 보류
  // setCenter before ReactFlow init is lost; defer until onInit
  const flowReadyRef = useRef(false);
  const pendingCenterRef = useRef<{ x: number; y: number } | null>(null);
  const centeredFocusRef = useRef<number | null>(null);

  useEffect(() => {
    fetchErdGraph()
      .then(setGraph)
      .catch((e: Error) => setError(e.message));
  }, []);

  const toggleNode = useCallback((id: number) => {
    setExpandedNodes((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const centerOn = useCallback((x: number, y: number) => {
    if (!flowReadyRef.current) {
      pendingCenterRef.current = { x, y };
      return;
    }
    void setCenter(x, y, { zoom: 0.75, duration: 300 });
  }, [setCenter]);

  // 그래프·접힘 변경 → 그룹별 ELK 재배치 / re-layout on graph or collapse changes
  useEffect(() => {
    if (!graph) return;
    let cancelled = false;
    const groups = groupConnectedComponents(graph.nodes, graph.edges);
    void layoutGroups(groups, graph.edges, expandedNodes).then((placed) => {
      if (cancelled) return;
      setFlowNodes(graph.nodes.map((n) => ({
        id: String(n.id),
        type: "tableNode" as const,
        position: { x: placed.get(n.id)?.x ?? 0, y: placed.get(n.id)?.y ?? 0 },
        data: {
          node: n,
          expanded: expandedNodes.has(n.id),
          // 읽기 전용에선 앵커 강조가 곧 focus 강조 / the anchor style doubles as focus
          isAnchor: n.id === focusId,
          highlightColumns: null,
          onExpandNeighbors: null, // 읽기 전용 — 이웃 확장 없음
          onToggleNode: toggleNode,
          onSelectColumn: () => undefined,
          onVisibleColumnsChange: () => undefined,
        },
      })));
      setFlowEdges(graph.edges.map((e) => {
        const visual = getEdgeVisual(e.kind, e.confidence ?? undefined);
        const ends = getCardinalityEnds(e.cardinality);
        const pairs = getColumnPairs(e);
        return {
          id: e.id,
          source: String(e.src_object_id),
          target: String(e.tgt_object_id),
          style: visual,
          markerStart: ends.source ? `url(#${MARKER_ID[ends.source]})` : undefined,
          markerEnd: ends.target ? `url(#${MARKER_ID[ends.target]})` : undefined,
          // 라벨은 컬럼명만 — 카디널리티는 마커, 근거는 클릭 카드가 맡는다
          label: pairs.length > 0 ? pairs.map((c) => c.src_column).join(", ") : undefined,
          labelStyle: { fontSize: 10, fill: "var(--slate)" },
          "data-testid": `ErdViewer-edge-${e.id}`,
        } as Edge;
      }));

      // focus 대상이 그래프에 있으면 그 좌표로 센터링 — 대상당 1회 / centre once per focus
      if (focusId === null || centeredFocusRef.current === focusId) return;
      const target = placed.get(focusId);
      if (!target) return;
      centeredFocusRef.current = focusId;
      centerOn(target.x + target.width / 2, target.y + target.height / 2);
    });
    return () => {
      cancelled = true;
    };
  }, [graph, expandedNodes, focusId, toggleNode, centerOn]);

  const nodeById = useMemo(
    () => new Map((graph?.nodes ?? []).map((n) => [n.id, n])),
    [graph],
  );
  const selectedEdge = useMemo(
    () => (graph?.edges ?? []).find((e) => e.id === selectedEdgeId) ?? null,
    [graph, selectedEdgeId],
  );

  const getQname = (id: number): string => {
    const node = nodeById.get(id);
    return node ? `${node.schema}.${node.name}` : String(id);
  };

  const isEmpty = graph !== null && graph.nodes.length === 0;
  const isFocusMissing = graph !== null && focusId !== null && !nodeById.has(focusId);

  return (
    <div className="relative h-full w-full" data-testid="ErdViewer-canvas">
      <CardinalityMarkerDefs />
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable
        onEdgeClick={(_event, edge) => setSelectedEdgeId(edge.id)}
        onPaneClick={() => setSelectedEdgeId(null)}
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
        onInit={() => {
          flowReadyRef.current = true;
          const pendingCenter = pendingCenterRef.current;
          if (!pendingCenter) return;
          pendingCenterRef.current = null;
          void setCenter(pendingCenter.x, pendingCenter.y, { zoom: 0.75 });
        }}
      >
        <Background color="var(--hairline)" />
        <Controls />
      </ReactFlow>
      <Legend />

      {graph === null && !error && (
        <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2
                        rounded-lg border px-3 py-1.5 text-xs"
             style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-card)",
                      color: "var(--body-text)" }}
             data-testid="ErdViewer-loading">
          <span className="skeleton h-2 w-16" />
          {t("erd.graphLoading")}
        </div>
      )}

      {isFocusMissing && (
        <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-3
                        rounded-lg border px-3 py-1.5 text-xs"
             style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-card)",
                      color: "var(--body-text)" }}
             data-testid="ErdViewer-focusMissingBanner">
          <span>
            {t("erd.focusMissing").replace("{label}", focusLabel ?? String(focusId))}
          </span>
          <Link
            className="btn-secondary !py-0.5 text-xs"
            href={`/verify?src=${focusId}&srcLabel=${encodeURIComponent(focusLabel ?? "")}`}
            data-testid="ErdViewer-focusMissingLink"
          >
            {t("erd.goVerify")}
          </Link>
        </div>
      )}

      {isEmpty && (
        <div className="absolute inset-0 z-10 flex items-center justify-center"
             data-testid="ErdViewer-emptyState">
          <div className="max-w-md rounded-xl border p-8 text-center"
               style={{ borderColor: "var(--hairline)", background: "var(--surface-card)" }}>
            <p className="mb-4 text-sm" style={{ color: "var(--slate)" }}>
              {t("erd.emptyReadOnly")}
            </p>
            <Link className="btn-primary" href="/verify" data-testid="ErdViewer-emptyVerifyLink">
              {t("erd.goVerify")}
            </Link>
          </div>
        </div>
      )}

      {/* 엣지 클릭 → 검증 근거 카드 / the clicked edge's provenance */}
      {selectedEdge && (
        <div className="absolute bottom-3 right-3 z-20 max-w-sm rounded-lg border px-3 py-2 text-xs"
             style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-card)",
                      color: "var(--body-text)" }}
             data-testid="ErdViewer-edgeDetail">
          <div className="mb-1 flex items-center gap-2">
            <span className="truncate font-mono font-semibold" style={{ color: "var(--ink)" }}>
              {getQname(selectedEdge.src_object_id)} → {getQname(selectedEdge.tgt_object_id)}
            </span>
            <button className="icon-button ml-auto"
                    onClick={() => setSelectedEdgeId(null)}
                    data-testid="ErdViewer-edgeDetailClose">
              <CloseIcon />
            </button>
          </div>
          <div style={{ color: "var(--slate)" }}>
            {t(GRADE_LABEL[getEdgeGrade(selectedEdge.kind)])}
          </div>
          <div className="font-mono">
            {getColumnPairs(selectedEdge)
              .map((c) => `${c.src_column} = ${c.tgt_column}`).join(", ")}
          </div>
          {selectedEdge.confidence !== null && selectedEdge.confidence !== undefined && (
            <div style={{ color: "var(--slate)" }}>
              confidence {selectedEdge.confidence.toFixed(2)}
            </div>
          )}
          {selectedEdge.cardinality && (
            <div style={{ color: "var(--slate)" }}>cardinality {selectedEdge.cardinality}</div>
          )}
          {selectedEdge.last_verified_at && (
            <div style={{ color: "var(--slate)" }}>
              {t("erd.edgeVerifiedAt")} {selectedEdge.last_verified_at}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded border px-3 py-2 text-sm"
             style={{ borderColor: "var(--error)", color: "var(--error)",
                      background: "var(--canvas)" }}
             data-testid="ErdViewer-errorBanner">
          {error}
        </div>
      )}
    </div>
  );
}
