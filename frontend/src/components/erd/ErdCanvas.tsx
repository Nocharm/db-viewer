"use client";

/** ERD 캔버스 — 앵커 확장·접힘·숨기기·호버 강조 / anchor-based ERD canvas. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyNodeChanges,
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import type { Edge, NodeChange } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { CloseIcon } from "@/components/icons";
import { useI18n } from "@/components/i18n";
import { PreviewSqlButton } from "@/components/PreviewSqlButton";
import { PreviewTable } from "@/components/PreviewTable";
import { fetchGraph, fetchObjectPreview, type TablePreview } from "@/lib/api";
import { PAIR_KINDS, resolveEdgeHandles, type NodeAnchorInfo } from "@/lib/edge-anchors";
import { buildCsv, sortRows, type SortSpec } from "@/lib/preview-utils";
import { getCardinalityEnds, getEdgeVisual, MARKER_ID } from "@/lib/edge-style";
import { NODE_CONFIRM_THRESHOLD, planMerge, type MergePlan } from "@/lib/graph-merge";
import { estimateNodeSize, layoutGraph } from "@/lib/layout";
import type { GraphEdge, GraphResponse } from "@/lib/types";
import { CardinalityMarkerDefs } from "@/components/erd/CardinalityMarkers";
import { TableNode, type TableFlowNode } from "./TableNode";
import { Legend } from "./Legend";

const nodeTypes = { tableNode: TableNode };

interface Props {
  anchorId: number | null;
  onSelectColumn: (columnId: number, columnName: string, objectQname: string) => void;
  onQuickStart: (name: string) => void;
}

// 빈 캔버스 가이드용 예시 앵커 / quick-start suggestions for the empty state
const QUICK_START_ANCHORS = ["HR_EMP", "ORD_SO_HDR", "MES_BATCH_HDR", "V_CHAIN_05"];

interface MenuState {
  type: "node" | "pane";
  nodeId: number | null;
  x: number;
  y: number;
}

interface EmphasisState {
  edgeIds: Set<string>;
  columnsByNode: Map<number, string[]>;
}

/** 엣지 하나의 강조 대상(엣지 + 양쪽 매칭 컬럼) 수집 / emphasis targets of one edge. */
function collectEdgeEmphasis(edge: GraphEdge, into: EmphasisState): void {
  into.edgeIds.add(edge.id);
  if (!PAIR_KINDS.has(edge.kind) || !Array.isArray(edge.columns)) return;
  for (const pair of edge.columns) {
    if (typeof pair === "string") continue;
    into.columnsByNode.set(edge.src_object_id, [
      ...(into.columnsByNode.get(edge.src_object_id) ?? []), pair.src_column,
    ]);
    into.columnsByNode.set(edge.tgt_object_id, [
      ...(into.columnsByNode.get(edge.tgt_object_id) ?? []), pair.tgt_column,
    ]);
  }
}

export function ErdCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <ErdCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function ErdCanvasInner({ anchorId, onSelectColumn, onQuickStart }: Props) {
  const { t } = useI18n();
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  // 모든 노드 기본 접힘 — 앵커만 자동 펼침 / everything folded; only the anchor auto-expands
  const [expandedNodes, setExpandedNodes] = useState<Set<number>>(new Set());
  // 숨긴 노드 — 레이아웃·엣지에서 제외, 우클릭 메뉴로 복원 / hidden via the context menu
  const [hiddenNodes, setHiddenNodes] = useState<Set<number>>(new Set());
  // 뷰 882개가 그래프를 폭발시킨다 — 기본 꺼짐, 표시 계층에서만 필터
  // views explode the graph at real scale; filtered at the display layer only
  const [showViews, setShowViews] = useState(false);
  // 노드별 '스크롤 뷰포트 안 컬럼' — 엣지 앵커 해석 입력 / per-node in-viewport columns
  const [viewportColumns, setViewportColumns] =
    useState<Map<number, Set<string>>>(new Map());
  const handleVisibleColumnsChange = useCallback((nodeId: number, columns: string[]) => {
    setViewportColumns((current) => {
      const previous = current.get(nodeId);
      const next = new Set(columns);
      // 같은 집합이면 그대로 — 무한 렌더 방지 / bail out on no-op to avoid a render loop
      if (previous && previous.size === next.size
          && [...next].every((c) => previous.has(c))) {
        return current;
      }
      const merged = new Map(current);
      merged.set(nodeId, next);
      return merged;
    });
  }, []);
  // 임계 초과 확인 대기 — 값은 켰을 때 그려질 노드 수 / node count awaiting confirmation
  const [pendingViews, setPendingViews] = useState<number | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [emphasis, setEmphasis] = useState<EmphasisState | null>(null);
  // ai_suggested 엣지 hover 시 판정 근거 부유 카드 / floating reason card on ai_suggested edge hover
  const [edgeReason, setEdgeReason] = useState<string | null>(null);
  // 우클릭 미리보기 — 하단 와이드 카드 / preview data for the bottom card
  const [preview, setPreview] = useState<TablePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewObjectId, setPreviewObjectId] = useState<number | null>(null);
  const [previewHeight, setPreviewHeight] = useState(256); // px — 드래그로 조절
  const [previewHidden, setPreviewHidden] = useState<string[]>([]);
  const [previewSort, setPreviewSort] = useState<SortSpec | null>(null);
  const [pending, setPending] = useState<MergePlan | null>(null);
  // 그래프 조회·레이아웃 계산 중 표시 / graph fetch + ELK layout in flight
  const [graphBusy, setGraphBusy] = useState(false);
  const [flowNodes, setFlowNodes] = useState<TableFlowNode[]>([]);
  const [flowEdges, setFlowEdges] = useState<Edge[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { setCenter } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const centeredAnchorRef = useRef<number | null>(null);
  // 헤더 드래그로 옮긴 노드는 재레이아웃에도 그 자리를 유지한다 / manual drags survive relayout
  const manualPosRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  // fresh 마운트에선 ReactFlow 초기화 전 setCenter가 무시된다 — init까지 보류
  // setCenter before ReactFlow init is lost on fresh mounts; defer until onInit
  const flowReadyRef = useRef(false);
  const pendingCenterRef = useRef<{ x: number; y: number } | null>(null);

  const centerOn = useCallback((x: number, y: number) => {
    if (!flowReadyRef.current) {
      pendingCenterRef.current = { x, y };
      return;
    }
    void setCenter(x, y, { zoom: 0.75, duration: 300 });
  }, [setCenter]);

  const applyIncoming = useCallback((incoming: GraphResponse, current: GraphResponse | null) => {
    const plan = planMerge(current, incoming);
    if (plan.needsConfirm) {
      setPending(plan); // 임계치 초과 → 확인 모달 (계획 §1.5)
    } else {
      setGraph(plan.merged);
    }
  }, []);

  const expandNeighbors = useCallback(
    (id: number) => {
      setGraphBusy(true);
      fetchGraph(id, 1)
        .then((incoming) => setGraph((cur) => {
          const plan = planMerge(cur, incoming);
          if (plan.needsConfirm) {
            setPending(plan);
            setGraphBusy(false); // 모달 대기 — 레이아웃 없음 / no layout while confirming
            return cur;
          }
          return plan.merged;
        }))
        .catch((e) => {
          setError(e.message);
          setGraphBusy(false);
        });
    },
    [],
  );

  const toggleNode = useCallback((id: number) => {
    setExpandedNodes((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // 앵커 변경 → 새 그래프 (기존 캔버스 대체, 앵커만 펼침) / new anchor replaces the canvas
  useEffect(() => {
    if (anchorId === null) return;
    setError(null);
    setGraphBusy(true);
    fetchGraph(anchorId, 1)
      .then((incoming) => {
        setGraph(null);
        setExpandedNodes(new Set([incoming.anchor_id]));
        setHiddenNodes(new Set());
        setMenu(null);
        setEmphasis(null);
        setEdgeReason(null);
        setPreview(null);
        manualPosRef.current = new Map(); // 새 캔버스 — 수동 배치 초기화
        applyIncoming(incoming, null);
      })
      .catch((e) => {
        setError(e.message);
        setGraphBusy(false);
      });
  }, [anchorId, applyIncoming]);

  // 드래그 반영 — position 변경만 수동 배치로 기록 / record drags as manual placements
  const handleNodesChange = useCallback((changes: NodeChange<TableFlowNode>[]) => {
    for (const change of changes) {
      if (change.type === "position" && change.position) {
        manualPosRef.current.set(Number(change.id), change.position);
      }
    }
    setFlowNodes((cur) => applyNodeChanges(changes, cur));
  }, []);

  // ── 컨텍스트 메뉴 (숨기기·복원) / context menus ──
  const openMenuAt = useCallback((event: MouseEvent | React.MouseEvent, nodeId: number | null) => {
    event.preventDefault();
    const rect = wrapperRef.current?.getBoundingClientRect();
    const clientX = "clientX" in event ? event.clientX : 0;
    const clientY = "clientY" in event ? event.clientY : 0;
    setMenu({
      type: nodeId === null ? "pane" : "node",
      nodeId,
      x: clientX - (rect?.left ?? 0),
      y: clientY - (rect?.top ?? 0),
    });
  }, []);

  // 바깥 클릭으로 메뉴 닫기 / close the menu on outside click
  useEffect(() => {
    if (!menu) return;
    const handleClick = (e: globalThis.MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menu]);

  const hideNode = useCallback((id: number) => {
    setHiddenNodes((cur) => new Set(cur).add(id));
  }, []);

  const hideOthers = useCallback((id: number) => {
    setGraph((cur) => {
      if (cur) setHiddenNodes(new Set(cur.nodes.map((n) => n.id).filter((n) => n !== id)));
      return cur;
    });
  }, []);

  const hiddenList = useMemo(
    () => (graph?.nodes ?? []).filter((n) => hiddenNodes.has(n.id)),
    [graph, hiddenNodes],
  );

  // 필터로 안 그려진 뷰 수 — 목록이 왜 짧은지 화면에서 드러나게 한다
  const filteredViewCount = useMemo(
    () => (showViews ? 0 : (graph?.nodes ?? []).filter((n) => n.type === "view").length),
    [graph, showViews],
  );

  const openPreview = useCallback((nodeId: number, limit?: number) => {
    setPreviewLoading(true);
    setPreviewObjectId(nodeId);
    fetchObjectPreview(nodeId, undefined, limit)
      .then((res) => {
        setPreview(res);
        // 다른 테이블로 전환 시 컬럼 상태 초기화 / reset per-table view state
        setPreviewHidden([]);
        setPreviewSort(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setPreviewLoading(false));
  }, []);

  // 카드 상단 드래그로 높이 조절 / drag the card's top edge to resize
  const startPreviewResize = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = previewHeight;
    const onMove = (e: PointerEvent) => {
      const next = startHeight + (startY - e.clientY);
      setPreviewHeight(Math.min(Math.max(next, 140), window.innerHeight * 0.7));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [previewHeight]);

  // ── 호버 강조 / hover emphasis ──
  const buildEdgeEmphasis = useCallback((edgeId: string) => {
    const edge = graph?.edges.find((e) => e.id === edgeId);
    if (!edge) return;
    const state: EmphasisState = { edgeIds: new Set(), columnsByNode: new Map() };
    collectEdgeEmphasis(edge, state);
    setEmphasis(state);
    setEdgeReason(edge.kind === "ai_suggested" && edge.reason ? edge.reason : null);
  }, [graph]);

  const buildNodeEmphasis = useCallback((nodeId: number) => {
    setEdgeReason(null); // 노드 hover로 전환 — 이전 엣지의 근거 카드 걷기
    if (!graph) return;
    const state: EmphasisState = { edgeIds: new Set(), columnsByNode: new Map() };
    for (const edge of graph.edges) {
      if (edge.src_object_id !== nodeId && edge.tgt_object_id !== nodeId) continue;
      if (hiddenNodes.has(edge.src_object_id) || hiddenNodes.has(edge.tgt_object_id)) continue;
      collectEdgeEmphasis(edge, state);
    }
    setEmphasis(state);
  }, [graph, hiddenNodes]);

  // 그래프·접힘·숨김 변경 → ELK 재배치 / re-layout on graph, collapse or hide changes
  useEffect(() => {
    if (!graph) {
      setFlowNodes([]);
      setFlowEdges([]);
      return;
    }
    let cancelled = false;
    const visibleGraphNodes = graph.nodes.filter(
      (n) => !hiddenNodes.has(n.id) && (showViews || n.type !== "view"),
    );
    const renderedIds = new Set(visibleGraphNodes.map((n) => n.id));
    const sized = visibleGraphNodes.map((n) => ({
      id: n.id,
      ...estimateNodeSize(n, expandedNodes.has(n.id)),
    }));
    // 렌더되지 않는 노드에 닿는 엣지 제외 + 접힌 뷰의 lineage 엣지 숨김
    const visibleEdges = graph.edges.filter(
      (e) => renderedIds.has(e.src_object_id) && renderedIds.has(e.tgt_object_id)
        && (e.kind !== "view_lineage" || expandedNodes.has(e.src_object_id)),
    );
    layoutGraph(sized, visibleEdges).then((positions) => {
      if (cancelled) return;
      const posMap = new Map(positions.map((p) => [p.id, p]));
      setFlowNodes(
        visibleGraphNodes.map((n) => ({
          id: String(n.id),
          type: "tableNode" as const,
          // 헤더만 드래그 핸들 — 컬럼 클릭과 충돌하지 않는다 / header is the drag handle
          dragHandle: ".erd-node__header",
          position: manualPosRef.current.get(n.id)
            ?? { x: posMap.get(n.id)?.x ?? 0, y: posMap.get(n.id)?.y ?? 0 },
          data: {
            node: n,
            expanded: expandedNodes.has(n.id),
            isAnchor: n.id === graph.anchor_id,
            highlightColumns: null,
            onExpandNeighbors: expandNeighbors,
            onToggleNode: toggleNode,
            onSelectColumn,
            onVisibleColumnsChange: handleVisibleColumnsChange,
          },
        })),
      );
      setFlowEdges(
        visibleEdges.map((e) => {
          const visual = getEdgeVisual(e.kind, e.confidence ?? undefined);
          // 라벨은 컬럼명만 — 카디널리티는 마커, 근거(✓·AI)는 엣지 클릭 시 표시
          // label carries columns only; cardinality goes to markers, provenance to click
          const label =
            PAIR_KINDS.has(e.kind) && Array.isArray(e.columns) && e.columns.length > 0
              ? (e.columns as { src_column: string }[]).map((c) => c.src_column).join(", ")
              : undefined;
          const ends = getCardinalityEnds(e.cardinality);
          return {
            id: e.id,
            source: String(e.src_object_id),
            target: String(e.tgt_object_id),
            style: visual,
            markerStart: ends.source ? `url(#${MARKER_ID[ends.source]})` : undefined,
            markerEnd: ends.target ? `url(#${MARKER_ID[ends.target]})` : undefined,
            label,
            labelStyle: { fontSize: 10, fill: "var(--slate)" },
            // 핸들 해석은 스크롤에 따라 바뀐다 — 레이아웃 밖에서 매 렌더 계산한다
            data: { graphEdge: e },
            "data-testid": `ErdCanvas-edge-${e.id}`,
          } as Edge;
        }),
      );
      setGraphBusy(false); // 레이아웃 반영 완료 / layout applied
      // 전체 맞춤 대신 앵커 좌표로 직접 센터링 — ELK 좌표를 알고 있어 측정 타이밍에 무관
      // center on the anchor's ELK coordinates; no dependence on node measurement timing
      if (centeredAnchorRef.current !== graph.anchor_id) {
        centeredAnchorRef.current = graph.anchor_id;
        const anchorPos = posMap.get(graph.anchor_id);
        const anchorSize = sized.find((s) => s.id === graph.anchor_id);
        if (anchorPos && anchorSize) {
          centerOn(
            anchorPos.x + anchorSize.width / 2,
            anchorPos.y + anchorSize.height / 2,
          );
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [graph, expandedNodes, hiddenNodes, showViews,
      expandNeighbors, toggleNode, onSelectColumn, handleVisibleColumnsChange, centerOn]);

  // 강조 상태를 렌더에만 입힌다 — ELK 재배치 없이 / emphasis decorates render only, no relayout
  const displayNodes = useMemo(() => {
    if (!emphasis) return flowNodes;
    return flowNodes.map((n) => {
      const columns = emphasis.columnsByNode.get(Number(n.id)) ?? null;
      if (columns === null && n.data.highlightColumns === null) return n;
      return { ...n, data: { ...n.data, highlightColumns: columns } };
    });
  }, [flowNodes, emphasis]);

  // 엣지 핸들은 스크롤에 따라 바뀐다 — ELK 재배치 없이 렌더 단계에서만 해석한다
  // handles depend on scroll position; resolved at render, never triggering a relayout
  const anchoredEdges = useMemo(() => {
    const anchorInfo = new Map<number, NodeAnchorInfo>(
      flowNodes.map((n) => [
        Number(n.id),
        {
          expanded: n.data.expanded,
          visibleColumns: viewportColumns.get(Number(n.id)) ?? new Set<string>(),
        },
      ]),
    );
    return flowEdges.map((e) => {
      const graphEdge = (e.data as { graphEdge?: GraphEdge } | undefined)?.graphEdge;
      if (!graphEdge) return e;
      return {
        ...e,
        ...resolveEdgeHandles(
          graphEdge,
          anchorInfo.get(graphEdge.src_object_id),
          anchorInfo.get(graphEdge.tgt_object_id),
        ),
      } as Edge;
    });
  }, [flowEdges, flowNodes, viewportColumns]);

  const displayEdges = useMemo(() => {
    if (!emphasis) return anchoredEdges;
    return anchoredEdges.map((e) => {
      const hit = emphasis.edgeIds.has(e.id);
      const baseWidth = Number((e.style as { strokeWidth?: number })?.strokeWidth ?? 1.4);
      return {
        ...e,
        style: hit
          ? { ...e.style, opacity: 1, strokeWidth: baseWidth + 1 }
          : { ...e.style, opacity: 0.12 },
        labelStyle: hit ? e.labelStyle : { ...e.labelStyle, opacity: 0.15 },
        zIndex: hit ? 10 : 0,
      } as Edge;
    });
  }, [anchoredEdges, emphasis]);

  return (
    <div ref={wrapperRef} className="relative h-full w-full" data-testid="ErdCanvas-root">
      <CardinalityMarkerDefs />

      {/* 뷰 렌더 필터 — 기본 OFF, 표시 계층에서만 필터 / view render filter, display-layer only */}
      <div
        className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded-lg border px-3 py-1.5"
        style={{ borderColor: "var(--hairline)", background: "var(--surface-card)" }}
        data-testid="ErdCanvas-viewFilter"
      >
        <label className="flex cursor-pointer items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={showViews}
            onChange={(event) => {
              const next = event.target.checked;
              // 뷰를 켜면 노드가 급증한다 — 이웃 확장과 같은 임계 확인을 태운다
              const wouldRender = (graph?.nodes ?? []).filter((n) => !hiddenNodes.has(n.id)).length;
              const rendered = (graph?.nodes ?? []).filter(
                (n) => !hiddenNodes.has(n.id) && n.type !== "view").length;
              if (next && wouldRender > NODE_CONFIRM_THRESHOLD
                  && rendered <= NODE_CONFIRM_THRESHOLD) {
                setPendingViews(wouldRender);
                return;
              }
              setShowViews(next);
            }}
            data-testid="ErdCanvas-showViewsToggle"
          />
          {t("erd.showViews")}
        </label>
        {filteredViewCount > 0 && (
          <span
            className="badge badge--muted"
            title={t("erd.viewsHiddenTip")}
            data-testid="ErdCanvas-viewsHiddenBadge"
          >
            {t("erd.viewsHidden").replace("{n}", String(filteredViewCount))}
          </span>
        )}
      </div>
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onNodeContextMenu={(event, node) => openMenuAt(event, Number(node.id))}
        onPaneContextMenu={(event) => openMenuAt(event, null)}
        onPaneClick={() => setMenu(null)}
        onEdgeMouseEnter={(_, edge) => buildEdgeEmphasis(edge.id)}
        onEdgeMouseLeave={() => { setEmphasis(null); setEdgeReason(null); }}
        onNodeMouseEnter={(_, node) => buildNodeEmphasis(Number(node.id))}
        onNodeMouseLeave={() => setEmphasis(null)}
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
        onInit={() => {
          flowReadyRef.current = true;
          const pendingCenter = pendingCenterRef.current;
          if (pendingCenter) {
            pendingCenterRef.current = null;
            void setCenter(pendingCenter.x, pendingCenter.y, { zoom: 0.75 });
          }
        }}
      >
        <Background color="var(--hairline)" />
        <Controls />
      </ReactFlow>
      <Legend />

      {/* 그래프 계산 배지 — 확장·레이아웃 대기 표시 / graph-busy badge */}
      {graphBusy && (
        <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2 rounded-lg border px-3 py-1.5 text-xs"
             style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-card)",
                      color: "var(--body-text)" }}
             data-testid="ErdCanvas-graphBusy">
          <span className="skeleton h-2 w-16" />
          {t("erd.graphLoading")}
        </div>
      )}

      {/* AI 제안 엣지 hover 판정 근거 — 렌더 데코레이션, 레이아웃 재계산 없음 / reason card, render-only */}
      {edgeReason && (
        <div className="absolute bottom-3 left-3 z-20 max-w-md rounded-lg border px-3 py-2 text-xs"
             style={{ borderColor: "var(--hairline)", background: "var(--surface-card)",
                      color: "var(--body-text)" }}
             data-testid="ErdCanvas-edgeReasonCard">
          <span className="font-semibold" style={{ color: "var(--stat-ink)" }}>AI</span> {edgeReason}
        </div>
      )}

      {/* 전체 펼침/접힘 툴바 — 선택적 정보 열람 보조 / bulk expand-collapse toolbar */}
      {graph && (
        <div className="absolute right-3 top-3 z-10 flex items-center gap-2"
             data-testid="ErdCanvas-toolbar">
          <span className="hidden text-xs md:inline" style={{ color: "var(--muted)" }}>
            {t("erd.dblClickHint")}
          </span>
          <button
            className="icon-button"
            onClick={() => setExpandedNodes(new Set(graph.nodes.map((n) => n.id)))}
            data-testid="ErdCanvas-expandAllButton"
          >
            {t("erd.expandAll")}
          </button>
          <button
            className="icon-button"
            onClick={() => setExpandedNodes(new Set())}
            data-testid="ErdCanvas-collapseAllButton"
          >
            {t("erd.collapseAll")}
          </button>
        </div>
      )}

      {/* 우클릭 메뉴 — 노드: 숨기기 / 바탕: 숨긴 테이블 복원 / context menus */}
      {menu && (
        <div ref={menuRef} className="erd-menu" style={{ left: menu.x, top: menu.y }}
             data-testid="ErdCanvas-contextMenu">
          {menu.type === "node" && menu.nodeId !== null ? (
            <>
              <button className="pressable erd-menu__item"
                      onClick={() => { openPreview(menu.nodeId as number); setMenu(null); }}
                      data-testid="ErdCanvas-previewItem">
                {t("detail.preview")}
              </button>
              <button className="pressable erd-menu__item"
                      onClick={() => { hideNode(menu.nodeId as number); setMenu(null); }}
                      data-testid="ErdCanvas-hideNodeItem">
                {t("erd.hideTable")}
              </button>
              <button className="pressable erd-menu__item"
                      onClick={() => { hideOthers(menu.nodeId as number); setMenu(null); }}
                      data-testid="ErdCanvas-hideOthersItem">
                {t("erd.hideOthers")}
              </button>
            </>
          ) : (
            <>
              <div className="erd-menu__label">
                {t("erd.hiddenTables")} ({hiddenList.length})
              </div>
              {hiddenList.length === 0 && (
                <div className="erd-menu__item" style={{ color: "var(--muted)" }}>
                  {t("erd.noHidden")}
                </div>
              )}
              <div className="scroll-area max-h-64 overflow-y-auto">
                {hiddenList.map((n) => (
                  <button key={n.id} className="pressable erd-menu__item font-mono text-xs"
                          onClick={() => setHiddenNodes((cur) => {
                            const next = new Set(cur);
                            next.delete(n.id);
                            return next;
                          })}
                          data-testid={`ErdCanvas-showNodeItem-${n.id}`}>
                    {n.schema}.{n.name}
                  </button>
                ))}
              </div>
              {hiddenList.length > 0 && (
                <button className="pressable erd-menu__item font-medium"
                        onClick={() => { setHiddenNodes(new Set()); setMenu(null); }}
                        data-testid="ErdCanvas-showAllItem">
                  {t("erd.showAll")}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* 하단 와이드 미리보기 카드 — 상단 드래그로 높이 조절 / resizable bottom preview card */}
      {(preview || previewLoading) && (
        <div
          className="absolute bottom-3 left-3 right-3 z-20 flex flex-col rounded-xl border"
          style={{
            borderColor: "var(--hairline-strong)", background: "var(--surface-card)",
            height: previewHeight,
          }}
          data-testid="ErdCanvas-previewCard"
        >
          <div
            className="h-2 shrink-0 cursor-row-resize rounded-t-xl"
            onPointerDown={startPreviewResize}
            title="드래그로 높이 조절"
            data-testid="ErdCanvas-previewResizeHandle"
          />
          <div className="flex items-center gap-2 px-4 pb-2">
            <span className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
              {t("preview.title")}
              {preview && <span className="ml-1.5 font-mono">{preview.object}</span>}
            </span>
            {preview && preview.masked_columns.length > 0 && (
              <span className="badge badge--muted">
                {t("preview.masked")} {preview.masked_columns.length}{t("preview.maskedSuffix")}
              </span>
            )}
            {previewLoading && (
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                {t("common.loading")}
              </span>
            )}
            <select
              className="ml-auto rounded border px-1.5 py-0.5 text-xs"
              style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-elevated)" }}
              title={t("preview.limitTitle")}
              value={preview?.limit ?? 20}
              onChange={(e) => previewObjectId !== null
                && openPreview(previewObjectId, Number(e.target.value))}
              data-testid="ErdCanvas-previewLimitSelect"
            >
              {[20, 50, 100, 200, 500].map((option) => (
                <option key={option} value={option}>TOP {option}</option>
              ))}
            </select>
            {preview && (
              <PreviewSqlButton
                state={{ object: preview.object, limit: preview.limit, filter: preview.filter }}
                visibleColumns={preview.columns.filter((c) => !previewHidden.includes(c))}
                sort={previewSort}
              />
            )}
            <button
              className="icon-button"
              disabled={!preview}
              onClick={() => {
                if (!preview) return;
                const visible = preview.columns.filter((c) => !previewHidden.includes(c));
                const blob = new Blob(
                  [buildCsv(visible, sortRows(preview.rows, previewSort))],
                  { type: "text/csv;charset=utf-8" });
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = `${preview.object.replace(".", "_")}_preview.csv`;
                anchor.click();
                URL.revokeObjectURL(url);
              }}
              data-testid="ErdCanvas-previewCsvButton"
            >
              {t("preview.csv")}
            </button>
            <button className="icon-button" onClick={() => setPreview(null)}
                    data-testid="ErdCanvas-previewCloseButton">
              <CloseIcon />
            </button>
          </div>
          {preview && (
            <div className="scroll-area min-h-0 flex-1 overflow-auto border-t"
                 style={{ borderColor: "var(--hairline)" }}>
              <PreviewTable
                data={preview}
                hidden={previewHidden}
                sort={previewSort}
                onToggleHidden={(column) => setPreviewHidden((cur) =>
                  cur.includes(column) ? cur.filter((c) => c !== column) : [...cur, column])}
                onSort={setPreviewSort}
              />
            </div>
          )}
        </div>
      )}

      {anchorId === null && (
        <div className="absolute inset-0 z-10 flex items-center justify-center"
             data-testid="ErdCanvas-emptyState">
          <div className="rounded-xl border p-8 text-center"
               style={{ borderColor: "var(--hairline)", background: "var(--surface-card)" }}>
            <p className="mb-2 text-lg font-bold" style={{ color: "var(--ink)" }}>
              {t("erd.emptyTitle")}
            </p>
            <p className="mb-4 text-sm" style={{ color: "var(--slate)" }}>
              {t("erd.emptyBody")}
              <br />{t("erd.emptyBody2")}
            </p>
            <div className="flex justify-center gap-2">
              {QUICK_START_ANCHORS.map((name) => (
                <button key={name} className="icon-button font-mono"
                        onClick={() => onQuickStart(name)}
                        data-testid={`ErdCanvas-quickStart-${name}`}>
                  {name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div
          className="absolute top-3 left-1/2 z-20 -translate-x-1/2 rounded border px-3 py-2 text-sm"
          style={{ borderColor: "var(--error)", color: "var(--error)", background: "var(--canvas)" }}
          data-testid="ErdCanvas-errorBanner"
        >
          {error}
        </div>
      )}

      {pending && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50">
          <div
            className="rounded-xl border p-6"
            style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-card)" }}
            data-testid="ErdCanvas-confirmModal"
          >
            <p className="mb-1 font-semibold" style={{ color: "var(--ink)" }}>
              {t("erd.confirmTitle").replace("{n}", String(pending.total))}
            </p>
            <p className="mb-4 text-sm" style={{ color: "var(--slate)" }}>
              {t("erd.confirmBody").replace("{n}", String(pending.addedCount))}
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="btn-secondary"
                data-testid="ErdCanvas-confirmCancelButton"
                onClick={() => setPending(null)}
              >
                {t("erd.cancel")}
              </button>
              <button
                className="btn-primary"
                data-testid="ErdCanvas-confirmRenderButton"
                onClick={() => {
                  setGraph(pending.merged);
                  setPending(null);
                }}
              >
                {t("erd.render")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 뷰 토글 임계 확인 — 그래프 병합 모달과 별개 (뷰 토글은 병합이 아니다) / separate from the merge-confirm modal */}
      {pendingViews !== null && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50">
          <div
            className="rounded-xl border p-6"
            style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-card)" }}
            data-testid="ErdCanvas-viewConfirmModal"
          >
            <p className="mb-4 text-sm" style={{ color: "var(--slate)" }}>
              {t("erd.viewConfirm").replace("{n}", String(pendingViews))}
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="btn-secondary"
                data-testid="ErdCanvas-viewConfirmCancel"
                onClick={() => setPendingViews(null)}
              >
                {t("erd.cancel")}
              </button>
              <button
                className="btn-primary"
                data-testid="ErdCanvas-viewConfirmOk"
                onClick={() => { setShowViews(true); setPendingViews(null); }}
              >
                {t("erd.render")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
