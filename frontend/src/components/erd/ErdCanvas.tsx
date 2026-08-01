"use client";

/** ERD 캔버스 — 앵커 확장·뷰 접힘·임계치 모달 / anchor-based ERD canvas. */

import { useCallback, useEffect, useRef, useState } from "react";
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

import { useI18n } from "@/components/i18n";
import { fetchGraph } from "@/lib/api";
import { getEdgeVisual } from "@/lib/edge-style";
import { planMerge, type MergePlan } from "@/lib/graph-merge";
import { estimateNodeSize, layoutGraph } from "@/lib/layout";
import type { GraphResponse } from "@/lib/types";
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
  const [pending, setPending] = useState<MergePlan | null>(null);
  const [flowNodes, setFlowNodes] = useState<TableFlowNode[]>([]);
  const [flowEdges, setFlowEdges] = useState<Edge[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { setCenter } = useReactFlow();
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
      fetchGraph(id, 1)
        .then((incoming) => setGraph((cur) => {
          const plan = planMerge(cur, incoming);
          if (plan.needsConfirm) {
            setPending(plan);
            return cur;
          }
          return plan.merged;
        }))
        .catch((e) => setError(e.message));
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
    fetchGraph(anchorId, 1)
      .then((incoming) => {
        setGraph(null);
        setExpandedNodes(new Set([incoming.anchor_id]));
        manualPosRef.current = new Map(); // 새 캔버스 — 수동 배치 초기화
        applyIncoming(incoming, null);
      })
      .catch((e) => setError(e.message));
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

  // 그래프·접힘 상태 변경 → ELK 재배치 / re-layout on graph or collapse changes
  useEffect(() => {
    if (!graph) {
      setFlowNodes([]);
      setFlowEdges([]);
      return;
    }
    let cancelled = false;
    const sized = graph.nodes.map((n) => ({
      id: n.id,
      ...estimateNodeSize(n, expandedNodes.has(n.id)),
    }));
    // 접힌 뷰의 lineage 엣지는 숨김 / hide lineage edges of collapsed views
    const visibleEdges = graph.edges.filter(
      (e) => e.kind !== "view_lineage" || expandedNodes.has(e.src_object_id),
    );
    layoutGraph(sized, visibleEdges).then((positions) => {
      if (cancelled) return;
      const posMap = new Map(positions.map((p) => [p.id, p]));
      setFlowNodes(
        graph.nodes.map((n) => ({
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
            onExpandNeighbors: expandNeighbors,
            onToggleNode: toggleNode,
            onSelectColumn,
          },
        })),
      );
      setFlowEdges(
        visibleEdges.map((e) => {
          const visual = getEdgeVisual(e.kind, e.confidence ?? undefined);
          const pairKinds = ["fk", "inferred", "confirmed", "ai_suggested"];
          let label =
            pairKinds.includes(e.kind) && Array.isArray(e.columns) && e.columns.length > 0
              ? (e.columns as { src_column: string }[])
                  .map((c) => c.src_column)
                  .join(", ")
              : undefined;
          // N:M은 FK 아님 — 교차 관계 표기 (계획 §3.2) / cross relation marker
          if (e.cardinality === "N:M") label = `${label ?? ""} [N:M]`.trim();
          if (e.kind === "confirmed") label = `✓ ${label ?? ""}`.trim();
          if (e.kind === "ai_suggested") label = `AI ${label ?? ""}`.trim();
          return {
            id: e.id,
            source: String(e.src_object_id),
            target: String(e.tgt_object_id),
            style: visual,
            label,
            labelStyle: { fontSize: 10, fill: "var(--slate)" },
            "data-testid": `ErdCanvas-edge-${e.id}`,
          } as Edge;
        }),
      );
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
  }, [graph, expandedNodes, expandNeighbors, toggleNode, onSelectColumn, centerOn]);

  return (
    <div className="relative h-full w-full" data-testid="ErdCanvas-root">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
        onInit={() => {
          flowReadyRef.current = true;
          const pending = pendingCenterRef.current;
          if (pending) {
            pendingCenterRef.current = null;
            void setCenter(pending.x, pending.y, { zoom: 0.75 });
          }
        }}
      >
        <Background color="var(--hairline)" />
        <Controls />
      </ReactFlow>
      <Legend />

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
    </div>
  );
}
