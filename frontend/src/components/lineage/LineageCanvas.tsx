"use client";

/** 계보 맵 캔버스 — 줌·드래그 팬과 노드 팝오버를 맡는다. 세 탭이 이 한 컴포넌트를 공유한다.
 *
 * 노드 드래그는 끈다: 배치가 depth를 뜻하므로(레인 = 계보 단계) 사용자가 옮기면 그림이
 * 거짓말을 한다. 캔버스 전체를 잡아끄는 팬과 줌만 남긴다.
 * / node dragging is off by design: x-position encodes depth, so moving a node would lie. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, useReactFlow,
} from "@xyflow/react";
import type { Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { NodePopover, type PopoverAnchor } from "@/components/lineage/NodePopover";
import { LineageNode, type LineageFlowNode } from "@/components/lineage/LineageNode";
import type { LineageNodeData } from "@/lib/api";
import { HOVER_RELEASE_MS, HOVER_SETTLE_MS } from "@/lib/use-deferred-hover";

const nodeTypes = { lineageNode: LineageNode };

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
  /** 노드 카드 클릭 — 미사용 컬럼 펼치기/접기 */
  onToggleExpand: (qname: string) => void;
  onFocusNode: (node: LineageNodeData) => void;
  onOpenObject: (node: LineageNodeData) => void;
  /** 맵의 기준 객체 qname — 팝오버에서 "중심으로 보기"를 숨길 대상 */
  rootKey: string;
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
  nodes, edges, focusKey, onHoverNode, onToggleExpand, onFocusNode, onOpenObject,
  rootKey, height,
}: Props) {
  const flow = useReactFlow();
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    if (releaseTimer.current !== null) clearTimeout(releaseTimer.current);
    hoverTimer.current = null;
    releaseTimer.current = null;
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  // 그래프가 통째로 바뀌면(탭 전환·기준 노드 변경) 떠 있던 팝오버는 남의 것이 된다
  useEffect(() => {
    setAnchor((current) => (current?.pinned ? current : null));
  }, [rootKey]);

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

  const handleNodeEnter = useCallback(
    (event: React.MouseEvent, node: LineageFlowNode) => {
      clearTimers();
      onHoverNode(node.id);
      const { clientX, clientY } = event;
      hoverTimer.current = setTimeout(() => {
        setAnchor((current) => (current?.pinned
          ? current
          : { node: node.data.node, x: clientX + 14, y: clientY + 10, pinned: false }));
      }, HOVER_SETTLE_MS);
    },
    [clearTimers, onHoverNode],
  );

  const handleNodeLeave = useCallback(() => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    onHoverNode(null);
    releaseTimer.current = setTimeout(() => {
      setAnchor((current) => (current?.pinned ? current : null));
    }, HOVER_RELEASE_MS);
  }, [onHoverNode]);

  // 카드 클릭은 펼침 토글이다(팝오버 고정은 팝오버의 핀 버튼이 맡는다) — 클릭 한 번에
  // 두 가지가 일어나면 어느 쪽을 의도했는지 화면이 말해 주지 못한다
  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: LineageFlowNode) => onToggleExpand(node.id),
    [onToggleExpand],
  );

  const defaultViewport = useMemo(() => ({ x: 0, y: 0, zoom: 0.85 }), []);

  return (
    <div className="lineage-canvas" style={{ height }} data-testid="LineageCanvas-root">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
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
        onPaneClick={() => { clearTimers(); setAnchor(null); }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1}
                    color="var(--hairline)" />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
      {anchor !== null && (
        <NodePopover
          anchor={anchor}
          onFocusNode={anchor.node.qname === rootKey || anchor.node.id === null
            ? null
            : (node) => { setAnchor(null); onFocusNode(node); }}
          onOpenObject={anchor.node.id === null || anchor.node.hidden
            ? null
            : (node) => { setAnchor(null); onOpenObject(node); }}
          onPin={() => setAnchor((current) => (current ? { ...current, pinned: true } : null))}
          onClose={() => { clearTimers(); setAnchor(null); }}
          onKeepAlive={clearTimers}
          onRelease={() => {
            releaseTimer.current = setTimeout(() => {
              setAnchor((current) => (current?.pinned ? current : null));
            }, HOVER_RELEASE_MS);
          }}
        />
      )}
    </div>
  );
}
