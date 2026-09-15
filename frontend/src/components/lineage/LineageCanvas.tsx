"use client";

/** 계보 맵 캔버스 — 줌·드래그 팬과 노드 팝오버를 맡는다. 세 탭이 이 한 컴포넌트를 공유한다.
 *
 * 노드 드래그는 끈다: 배치가 depth를 뜻하므로(레인 = 계보 단계) 사용자가 옮기면 그림이
 * 거짓말을 한다. 캔버스 전체를 잡아끄는 팬과 줌만 남긴다.
 * / node dragging is off by design: x-position encodes depth, so moving a node would lie. */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, useReactFlow,
} from "@xyflow/react";
import type { Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { LineageEdge } from "@/components/lineage/LineageEdge";
import { NodePopover, type PopoverAnchor } from "@/components/lineage/NodePopover";
import { LineageNode, type LineageFlowNode } from "@/components/lineage/LineageNode";
import type { LineageNodeData } from "@/lib/api";

const nodeTypes = { lineageNode: LineageNode };
const edgeTypes = { lineageEdge: LineageEdge };

/** SQL 줄 호버로 노드를 찾아갈 때의 줌 배율 — 카드 글자가 읽히는 최소치 */
const FOCUS_ZOOM = 1.15;
/** 카메라 이동 시간(ms) — 순간이동하면 어디서 어디로 갔는지 놓친다 */
const FOCUS_DURATION_MS = 420;

interface Props {
  nodes: LineageFlowNode[];
  edges: Edge[];
  /** 이 노드로 카메라를 옮긴다 — SQL 줄 호버가 밀어 넣는다 / camera target from the SQL pane */
  focusKey: string | null;
  onHoverNode: (qname: string | null) => void;
  onFocusNode: (node: LineageNodeData) => void;
  onOpenObject: (node: LineageNodeData) => void;
  /** 맵의 기준 객체 qname — 팝오버에서 "중심으로 보기"를 숨길 대상 */
  rootKey: string;
  /** 노드별 AI 요약 세션 캐시 — 한 번 만든 요약을 다시 만들지 않는다 */
  summaries: Map<string, { summary: string; mock: boolean }>;
  onSummary: (qname: string, summary: string, mock: boolean) => void;
  height: number;
}

export function LineageCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <LineageCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function LineageCanvasInner({
  nodes, edges, focusKey, onHoverNode, onFocusNode, onOpenObject,
  rootKey, summaries, onSummary, height,
}: Props) {
  const flow = useReactFlow();
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);

  // 그래프가 통째로 바뀌면(탭 전환·기준 노드 변경) 떠 있던 카드는 남의 것이 된다
  useEffect(() => { setAnchor(null); }, [rootKey]);

  // SQL 줄 호버 → 그 노드로 카메라 이동. 좌표는 배치 결과에서 읽는다(렌더 대기 없음)
  useEffect(() => {
    if (focusKey === null) return;
    const target = nodes.find((node) => node.id === focusKey);
    if (!target) return;
    const width = target.measured?.width ?? target.width ?? 236;
    const nodeHeight = target.measured?.height ?? target.height ?? 60;
    flow.setCenter(
      target.position.x + width / 2,
      target.position.y + nodeHeight / 2,
      { zoom: FOCUS_ZOOM, duration: FOCUS_DURATION_MS },
    );
  }, [focusKey, nodes, flow]);

  // 호버는 SQL 패널 연동 전용이다 — 카드를 띄우지 않는다(맵을 훑기만 해도 시야가 가려졌다)
  const handleNodeEnter = useCallback(
    (_event: React.MouseEvent, node: LineageFlowNode) => onHoverNode(node.id),
    [onHoverNode],
  );
  const handleNodeLeave = useCallback(() => onHoverNode(null), [onHoverNode]);

  // 카드 클릭 = 정보 카드. 노드의 화면 사각형을 넘겨 팝오버가 그 바깥에 서게 한다
  // (마우스 좌표만 넘기면 카드가 정작 보려던 노드 위에 앉는다)
  const handleNodeClick = useCallback(
    (event: React.MouseEvent, node: LineageFlowNode) => {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      setAnchor({
        node: node.data.node,
        nodeRight: rect.right,
        nodeLeft: rect.left,
        pointerY: event.clientY,
      });
    },
    [],
  );

  const defaultViewport = useMemo(() => ({ x: 0, y: 0, zoom: 0.85 }), []);

  return (
    <div className="lineage-canvas" style={{ height }} data-testid="LineageCanvas-root">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultViewport={defaultViewport}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1.1 }}
        minZoom={0.2}
        maxZoom={2.2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
        panOnScroll={false}
        zoomOnScroll
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        onNodeMouseEnter={handleNodeEnter}
        onNodeMouseLeave={handleNodeLeave}
        onNodeClick={handleNodeClick}
        onPaneClick={() => setAnchor(null)}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1}
                    color="var(--hairline)" />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
      {anchor !== null && (
        <NodePopover
          anchor={anchor}
          isCurrentRoot={anchor.node.qname === rootKey}
          knownSummary={summaries.get(anchor.node.qname)?.summary ?? null}
          isMock={summaries.get(anchor.node.qname)?.mock ?? false}
          onSummary={onSummary}
          onFocusNode={anchor.node.qname === rootKey || anchor.node.id === null
            ? null
            : (node) => { setAnchor(null); onFocusNode(node); }}
          onOpenObject={anchor.node.id === null || anchor.node.hidden
            ? null
            : (node) => { setAnchor(null); onOpenObject(node); }}
          onClose={() => setAnchor(null)}
        />
      )}
    </div>
  );
}
