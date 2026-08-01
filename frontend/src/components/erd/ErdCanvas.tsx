"use client";

/** ERD 캔버스 — 앵커 확장·뷰 접힘·임계치 모달 / anchor-based ERD canvas. */

import { useCallback, useEffect, useState } from "react";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import type { Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

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
}

export function ErdCanvas({ anchorId }: Props) {
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [expandedViews, setExpandedViews] = useState<Set<number>>(new Set());
  const [pending, setPending] = useState<MergePlan | null>(null);
  const [flowNodes, setFlowNodes] = useState<TableFlowNode[]>([]);
  const [flowEdges, setFlowEdges] = useState<Edge[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  const toggleView = useCallback((id: number) => {
    setExpandedViews((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // 앵커 변경 → 새 그래프 (기존 캔버스 대체) / new anchor replaces the canvas
  useEffect(() => {
    if (anchorId === null) return;
    setError(null);
    fetchGraph(anchorId, 1)
      .then((incoming) => {
        setGraph(null);
        setExpandedViews(new Set());
        applyIncoming(incoming, null);
      })
      .catch((e) => setError(e.message));
  }, [anchorId, applyIncoming]);

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
      ...estimateNodeSize(n, expandedViews.has(n.id)),
    }));
    // 접힌 뷰의 lineage 엣지는 숨김 / hide lineage edges of collapsed views
    const visibleEdges = graph.edges.filter(
      (e) => e.kind !== "view_lineage" || expandedViews.has(e.src_object_id),
    );
    layoutGraph(sized, visibleEdges).then((positions) => {
      if (cancelled) return;
      const posMap = new Map(positions.map((p) => [p.id, p]));
      setFlowNodes(
        graph.nodes.map((n) => ({
          id: String(n.id),
          type: "tableNode" as const,
          position: { x: posMap.get(n.id)?.x ?? 0, y: posMap.get(n.id)?.y ?? 0 },
          data: {
            node: n,
            viewExpanded: expandedViews.has(n.id),
            isAnchor: n.id === graph.anchor_id,
            onExpandNeighbors: expandNeighbors,
            onToggleView: toggleView,
          },
        })),
      );
      setFlowEdges(
        visibleEdges.map((e) => {
          const visual = getEdgeVisual(e.kind);
          const label =
            e.kind === "fk" && Array.isArray(e.columns) && e.columns.length > 0
              ? (e.columns as { src_column: string }[])
                  .map((c) => c.src_column)
                  .join(", ")
              : undefined;
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
    });
    return () => {
      cancelled = true;
    };
  }, [graph, expandedViews, expandNeighbors, toggleView]);

  return (
    <div className="relative h-full w-full" data-testid="ErdCanvas-root">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--hairline)" />
        <Controls />
      </ReactFlow>
      <Legend />

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
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/20">
          <div
            className="rounded-2xl border bg-white p-6"
            style={{ borderColor: "var(--hairline)" }}
            data-testid="ErdCanvas-confirmModal"
          >
            <p className="mb-1 font-medium">노드 {pending.total}개를 렌더링할까요?</p>
            <p className="mb-4 text-sm" style={{ color: "var(--slate)" }}>
              이번 확장으로 {pending.addedCount}개가 추가됩니다. 큰 그래프는 탐색이 느려질 수 있습니다.
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="icon-button"
                data-testid="ErdCanvas-confirmCancelButton"
                onClick={() => setPending(null)}
              >
                취소
              </button>
              <button
                className="rounded-full px-4 py-1.5 text-sm text-white"
                style={{ background: "var(--primary)" }}
                data-testid="ErdCanvas-confirmRenderButton"
                onClick={() => {
                  setGraph(pending.merged);
                  setPending(null);
                }}
              >
                렌더링
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
