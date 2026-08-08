"use client";

/** 읽기 전용 ERD — 확정된 관계 전체를 연결요소별로 적층해 보여준다.
 * Read-only whole-graph ERD; connected components are laid out and stacked top-down. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  applyNodeChanges, Background, Controls, ReactFlow, ReactFlowProvider, useReactFlow,
} from "@xyflow/react";
import type { Edge, NodeChange } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { CloseIcon } from "@/components/icons";
import { useI18n } from "@/components/i18n";
import { CardinalityMarkerDefs } from "@/components/erd/CardinalityMarkers";
import { fetchErdGraph } from "@/lib/api";
import {
  getCardinalityEnds, getEdgeGrade, getEdgeVisual, MARKER_ID, type EdgeGrade,
} from "@/lib/edge-style";
import { applyManualPositions, groupConnectedComponents, type PlacedNode } from "@/lib/erd-graph";
import type { MessageKey } from "@/lib/i18n";
import { estimateNodeSize, layoutGraph } from "@/lib/layout";
import type { ErdResponse, GraphEdge, GraphNode } from "@/lib/types";
import { ErdSearch } from "./ErdSearch";
import { Legend } from "./Legend";
import { TableNode, type TableFlowNode } from "./TableNode";

const nodeTypes = { tableNode: TableNode };

/** 연결요소 사이 세로 간격(px) — 그룹 경계를 알아보게 하는 유일한 단서라 여백이 넉넉해야 한다 */
const GROUP_GAP = 120;

/** 호버 세션 중 나머지 엣지 투명도 — 등급별 기본 톤(0.5~1.0)보다 확실히 낮아야 대비가 선다 */
const HOVER_DIM_OPACITY = 0.25;

/** 호버 라벨 필 — 새 색 없이 카드 표면·hairline 테두리 재사용 / surface + hairline, no new hues */
const EDGE_LABEL_STYLE = { fontSize: 11, fill: "var(--ink)" } as const;
const EDGE_LABEL_BG_STYLE = {
  fill: "var(--surface-card)", stroke: "var(--hairline-strong)", strokeWidth: 1,
} as const;
const EDGE_LABEL_BG_PADDING: [number, number] = [6, 3];

/** 엣지 등급 → 범례와 같은 문구 / edge grade to the same wording the legend uses */
const GRADE_LABEL: Record<EdgeGrade, MessageKey> = {
  confirmed: "erd.legendConfirmed",
  inferred: "erd.legendInferredGrade",
  unresolved: "erd.legendUnresolvedGrade",
  lineage: "erd.legendLineageGrade",
};

/** 컬럼 페어만 추린다 — /api/erd는 fk·confirmed만 주므로 실질적으로 전량이다.
 * GraphEdge.columns is a union; view lineage carries plain strings. */
function getColumnPairs(edge: GraphEdge): { src_column: string; tgt_column: string }[] {
  return edge.columns.filter(
    (c): c is { src_column: string; tgt_column: string } => typeof c !== "string");
}

/** 호버 라벨 문구 — 첫 페어만 쓰고 나머지는 개수로 접는다(선 위 필이 길어지면 노드를 가린다).
 * first pair only; the rest collapse into a +N counter. */
function formatColumnPairLabel(edge: GraphEdge): string | undefined {
  const pairs = getColumnPairs(edge);
  const first = pairs[0];
  if (!first) return undefined;
  const rest = pairs.length - 1;
  return `${first.src_column} → ${first.tgt_column}${rest > 0 ? ` +${rest}` : ""}`;
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
  // 호버 세션은 스타일 전용 state — 재레이아웃 없이 강조·감쇠·라벨만 갈아 끼운다
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [flowNodes, setFlowNodes] = useState<TableFlowNode[]>([]);
  const [flowEdges, setFlowEdges] = useState<Edge[]>([]);
  const [error, setError] = useState<string | null>(null);
  // isAnchor 하이라이트의 일반화 상태 — 초기값은 URL ?focus=, 이후 맵 검색 픽으로 갱신된다.
  // focusMissing 배너는 이 state가 아니라 URL 원본 focusId를 계속 참조한다(검색 픽이 배너를 띄우면 안 됨).
  const [highlightedId, setHighlightedId] = useState<number | null>(focusId);
  const { setCenter, fitView } = useReactFlow();
  // fresh 마운트에선 ReactFlow 초기화 전 setCenter가 무시된다 — onInit까지 보류
  // setCenter before ReactFlow init is lost; defer until onInit
  const flowReadyRef = useRef(false);
  const pendingCenterRef = useRef<{ x: number; y: number } | null>(null);
  const centeredFocusRef = useRef<number | null>(null);
  // focus 없이 진입한 첫 레이아웃에서 전체 맞춤 — 재레이아웃마다 반복 호출하지 않도록 1회만
  const fitViewDoneRef = useRef(false);
  const pendingFitViewRef = useRef(false);
  // 마지막으로 배치된 노드 좌표 — 맵 검색 픽이 레이아웃 이펙트 밖에서도 centerOn 좌표를 찾을 수 있게 한다
  const placedRef = useRef<Map<number, PlacedNode>>(new Map());
  // 수동 이동 좌표 — ref인 이유: 레이아웃 이펙트 deps에 들어가면 드래그마다 ELK가 재실행된다
  // (호버가 레이아웃을 안 흔드는 것과 같은 원칙) / manual positions live in a ref so
  // dragging never re-triggers ELK
  const movedRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  // 초기화 버튼 활성 판정 전용 — ELK와 무관한 가벼운 리렌더만 유발
  const [movedCount, setMovedCount] = useState(0);
  // 마지막 순수 ELK 배치 — 위치 초기화가 ELK 재실행 없이 이걸 그대로 복원한다
  const elkPlacedRef = useRef<Map<number, PlacedNode>>(new Map());
  // 최초 레이아웃이 끝나기 전에 검색을 픽하면 placedRef가 아직 비어 있다 — 레이아웃 완료 후 처리하도록 대상만 남겨둔다
  const pendingCenterIdRef = useRef<number | null>(null);

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

  // 엣지 호버 = 라벨·강조 + (이미 펼쳐진 노드에만) 컬럼 하이라이트. 펼침은 하지 않는다 —
  // 호버만으로 레이아웃이 움직이면 포인터 아래 그래프가 요동친다. 펼침은 엣지 클릭이 담당.
  // hover shows the label and highlights columns on already-expanded nodes only;
  // expanding both ends moved to edge click so hovering never reflows the graph
  const handleEdgeMouseEnter = useCallback((_event: unknown, edge: Edge) => {
    setHoveredEdgeId(edge.id);
  }, []);

  // 떠난 엣지가 지금 호버 중인 엣지일 때만 해제 — 엣지 재마운트로 leave가 늦게 도착하면
  // 이미 시작된 다음 호버를 지워버린다 / only clear the session this leave belongs to
  const handleEdgeMouseLeave = useCallback((_event: unknown, edge: Edge) => {
    setHoveredEdgeId((current) => (current === edge.id ? null : current));
  }, []);

  // 드래그 중 position 변경만 반영 — dimension 변경까지 적용하면 measured 수동 관리와
  // 충돌한다(위 displayNodes 주석 참조) / apply position changes only; dimension changes
  // would fight our manual `measured` bookkeeping
  const handleNodesChange = useCallback((changes: NodeChange<TableFlowNode>[]) => {
    const positionChanges = changes.filter((c) => c.type === "position");
    if (positionChanges.length === 0) return;
    setFlowNodes((nodes) => applyNodeChanges(positionChanges, nodes));
  }, []);

  const handleNodeDragStop = useCallback((_event: unknown, node: TableFlowNode) => {
    const id = Number(node.id);
    movedRef.current.set(id, { x: node.position.x, y: node.position.y });
    setMovedCount(movedRef.current.size);
    // 검색 픽 센터링(placedRef 기반)이 옮긴 위치를 조준하도록 배치 기록도 갱신
    const placedEntry = placedRef.current.get(id);
    if (placedEntry) {
      placedRef.current.set(id, { ...placedEntry, x: node.position.x, y: node.position.y });
    }
  }, []);

  const centerOn = useCallback((x: number, y: number) => {
    if (!flowReadyRef.current) {
      pendingCenterRef.current = { x, y };
      return;
    }
    void setCenter(x, y, { zoom: 0.75, duration: 500 });
  }, [setCenter]);

  // 맵 검색 픽 → 하이라이트 갱신 + 마지막 배치 좌표로 센터링(fetch 없이 로드된 nodes 기반)
  const handleSearchPick = useCallback((id: number) => {
    setHighlightedId(id);
    const target = placedRef.current.get(id);
    if (target) {
      centerOn(target.x + target.width / 2, target.y + target.height / 2);
    } else {
      // 최초 레이아웃 완료 전 픽 — 레이아웃 이펙트의 post-layout 센터링이 이어받는다
      pendingCenterIdRef.current = id;
    }
  }, [centerOn]);

  const fitViewOnce = useCallback(() => {
    if (fitViewDoneRef.current) return;
    fitViewDoneRef.current = true;
    if (!flowReadyRef.current) {
      pendingFitViewRef.current = true;
      return;
    }
    void fitView({ duration: 300 });
  }, [fitView]);

  // 그래프·접힘 변경 → 그룹별 ELK 재배치 / re-layout on graph or collapse changes
  useEffect(() => {
    if (!graph) return;
    let cancelled = false;
    const groups = groupConnectedComponents(graph.nodes, graph.edges);
    void layoutGroups(groups, graph.edges, expandedNodes).then((elkPlaced) => {
      if (cancelled) return;
      elkPlacedRef.current = elkPlaced;
      // 수동 이동 좌표를 ELK 결과 위에 덮어쓴다 — 재레이아웃(펼침/접힘)에도 배치가 유지된다
      const placed = applyManualPositions(elkPlaced, movedRef.current);
      placedRef.current = placed;
      setFlowNodes(graph.nodes.map((n) => {
        const expanded = expandedNodes.has(n.id);
        return {
          id: String(n.id),
          type: "tableNode" as const,
          // 헤더만 드래그 그립 — 컬럼 행 클릭·스크롤·조인 핸들과 간섭하지 않는다
          dragHandle: ".erd-node__header",
          position: { x: placed.get(n.id)?.x ?? 0, y: placed.get(n.id)?.y ?? 0 },
          // measured를 여기서부터 실어 보낸다 — 없으면 이 배열이 통째로 교체될 때(검색 픽
          // 이후 재레이아웃 등) React Flow가 모든 노드를 미측정으로 되돌려 handleBounds가
          // 리셋되고 그 노드들의 엣지가 한 프레임 통째로 언마운트된다(@xyflow/system
          // parseHandles). displayNodes가 같은 패턴으로 이어받는다.
          measured: estimateNodeSize(n, expanded),
          data: {
            node: n,
            expanded,
            // isAnchor는 displayNodes에서 highlightedId로 계산한다 — 검색 픽마다 이 이펙트가
            // 다시 돌면 ELK가 불필요하게 재실행된다(레이아웃과 하이라이트를 분리).
            isAnchor: false,
            highlightColumns: null,
            onExpandNeighbors: null, // 읽기 전용 — 이웃 확장 없음
            onToggleNode: toggleNode,
            onSelectColumn: () => undefined,
            onVisibleColumnsChange: () => undefined,
          },
        };
      }));
      setFlowEdges(graph.edges.map((e) => {
        const visual = getEdgeVisual(e.kind, e.confidence ?? undefined);
        const ends = getCardinalityEnds(e.cardinality);
        return {
          id: e.id,
          // 꺾은선 — layout.ts의 엣지 간격 확보와 짝을 이뤄 노드 관통을 줄인다
          type: "smoothstep",
          source: String(e.src_object_id),
          target: String(e.tgt_object_id),
          style: visual,
          markerStart: ends.source ? `url(#${MARKER_ID[ends.source]})` : undefined,
          markerEnd: ends.target ? `url(#${MARKER_ID[ends.target]})` : undefined,
          // 라벨은 호버 중인 엣지에만 — 전량 표시는 선 위 글자가 그래프를 덮는다(아래 displayEdges)
          "data-testid": `ErdViewer-edge-${e.id}`,
        } as Edge;
      }));

      // post-layout 센터링 우선순위: ① 레이아웃 완료 전 남겨둔 검색 픽 ② focus 없는 첫 진입의 전체 맞춤
      // ③ URL focus 센터링 — ①②③ 모두 대상당 1회. 검색 픽이 있었다면 ②③의 "1회"를 이미 소모 처리해
      // 이후 재레이아웃(펼침 토글 등)에서 뒤늦게 끼어들어 카메라를 되돌리지 않게 한다.
      const pendingCenterId = pendingCenterIdRef.current;
      if (pendingCenterId !== null) {
        pendingCenterIdRef.current = null;
        fitViewDoneRef.current = true;
        if (focusId !== null) centeredFocusRef.current = focusId;
        const target = placed.get(pendingCenterId);
        if (target) centerOn(target.x + target.width / 2, target.y + target.height / 2);
        return;
      }
      if (focusId === null) {
        fitViewOnce();
        return;
      }
      if (centeredFocusRef.current === focusId) return;
      const target = placed.get(focusId);
      if (!target) return;
      centeredFocusRef.current = focusId;
      centerOn(target.x + target.width / 2, target.y + target.height / 2);
    });
    return () => {
      cancelled = true;
    };
    // highlightedId는 여기서 안 쓴다 — 검색 픽은 displayNodes의 isAnchor만 갈아 끼우고
    // ELK 재레이아웃은 건드리지 않는다 / search picks skip this effect on purpose
  }, [graph, expandedNodes, focusId, toggleNode, centerOn, fitViewOnce]);

  const nodeById = useMemo(
    () => new Map((graph?.nodes ?? []).map((n) => [n.id, n])),
    [graph],
  );
  const selectedEdge = useMemo(
    () => (graph?.edges ?? []).find((e) => e.id === selectedEdgeId) ?? null,
    [graph, selectedEdgeId],
  );
  const hoveredEdge = useMemo(
    () => (graph?.edges ?? []).find((e) => e.id === hoveredEdgeId) ?? null,
    [graph, hoveredEdgeId],
  );

  // 앵커(검색 픽·URL focus)·호버 오버레이는 레이아웃 결과(flowNodes/flowEdges) 위에 덧씌운다 —
  // 재계산이 배치를 다시 흔들지 않게, 그리고 새로 만드는 모든 노드 객체에 measured를 실어
  // handleBounds가 리셋되지 않게 한다. measured 없이 나가면 adoptUserNodes가 그 노드를
  // 미측정으로 되돌리고(@xyflow/system parseHandles: userNode.measured 없으면 handleBounds까지
  // undefined) 그 노드에 붙은 엣지가 한 프레임 언마운트된다 — 검색 픽 하이라이트 갱신에서도
  // 예외가 아니라서 매핑 전량에 붙인다.
  // every object this produces carries `measured`, or its edges flash for a frame on swap —
  // that includes the isAnchor-only update path a search pick takes, not just hover
  const displayNodes = useMemo(() => {
    const pairs = hoveredEdge ? getColumnPairs(hoveredEdge) : [];
    const srcId = hoveredEdge ? String(hoveredEdge.src_object_id) : null;
    const tgtId = hoveredEdge ? String(hoveredEdge.tgt_object_id) : null;
    return flowNodes.map((n) => {
      // self-join이면 한 노드가 양끝이라 두 목록을 합친다
      const columns = [
        ...(n.id === srcId ? pairs.map((c) => c.src_column) : []),
        ...(n.id === tgtId ? pairs.map((c) => c.tgt_column) : []),
      ];
      return {
        ...n,
        measured: estimateNodeSize(n.data.node, n.data.expanded),
        data: {
          ...n.data,
          // 읽기 전용에선 앵커 강조가 곧 focus 강조 / the anchor style doubles as focus
          isAnchor: n.data.node.id === highlightedId,
          highlightColumns: columns.length > 0 ? columns : null,
        },
      };
    });
  }, [flowNodes, hoveredEdge, highlightedId]);

  const displayEdges = useMemo(() => {
    if (!hoveredEdge) return flowEdges;
    const dimmed: Edge[] = [];
    let emphasized: Edge | null = null;
    for (const e of flowEdges) {
      if (e.id !== hoveredEdge.id) {
        dimmed.push({ ...e, style: { ...e.style, opacity: HOVER_DIM_OPACITY } });
        continue;
      }
      const width = typeof e.style?.strokeWidth === "number" ? e.style.strokeWidth : 2;
      emphasized = {
        ...e,
        style: { ...e.style, strokeWidth: width + 1, opacity: 1 },
        label: formatColumnPairLabel(hoveredEdge),
        labelShowBg: true,
        labelStyle: EDGE_LABEL_STYLE,
        labelBgStyle: EDGE_LABEL_BG_STYLE,
        labelBgPadding: EDGE_LABEL_BG_PADDING,
        labelBgBorderRadius: 6,
      };
    }
    // 배열 맨 뒤 = 다른 엣지 위. zIndex를 올리면 엣지 레이어가 노드 레이어까지 넘어서
    // 긴 엣지가 카드를 관통해 보인다 / last in the array, not raised out of the edge layer
    return emphasized ? [...dimmed, emphasized] : dimmed;
  }, [flowEdges, hoveredEdge]);

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
        nodes={displayNodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        nodesConnectable={false}
        onNodesChange={handleNodesChange}
        onNodeDragStop={handleNodeDragStop}
        edgesFocusable
        // 헤더 더블클릭 = 펼침/접힘 전용. d3의 dblclick.zoom은 캔버스 자체에 걸려 있어
        // 노드 쪽 stopPropagation으로는 못 막는다 — 여기서 꺼야 줌이 같이 튀지 않는다
        // / d3 binds dblclick.zoom on the pane, so stopPropagation upstream cannot stop it
        zoomOnDoubleClick={false}
        onEdgeClick={(_event, edge) => {
          setSelectedEdgeId(edge.id);
          // 클릭이 펼침 담당 — 양끝을 펼쳐 컬럼 하이라이트·스크롤이 보이게 한다
          // click owns expansion: open both ends so the highlighted columns show
          const ends = [Number(edge.source), Number(edge.target)];
          setExpandedNodes((current) => {
            // 이미 둘 다 펼쳐져 있으면 같은 Set을 돌려 재레이아웃 자체를 건너뛴다
            if (ends.every((id) => current.has(id))) return current;
            const next = new Set(current);
            for (const id of ends) next.add(id);
            return next;
          });
        }}
        onEdgeMouseEnter={handleEdgeMouseEnter}
        onEdgeMouseLeave={handleEdgeMouseLeave}
        onPaneClick={() => setSelectedEdgeId(null)}
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
        onInit={() => {
          flowReadyRef.current = true;
          const pendingCenter = pendingCenterRef.current;
          if (pendingCenter) {
            pendingCenterRef.current = null;
            void setCenter(pendingCenter.x, pendingCenter.y, { zoom: 0.75 });
          }
          if (pendingFitViewRef.current) {
            pendingFitViewRef.current = false;
            void fitView({ duration: 300 });
          }
        }}
      >
        <Background color="var(--hairline)" />
        <Controls />
      </ReactFlow>
      <ErdSearch nodes={graph?.nodes ?? []} onPick={handleSearchPick} loading={graph === null} />

      {/* 우하단 스택 — 엣지 상세 카드(있으면 위) + 범례(항상 아래) — 같은 앵커라 겹치지 않게 세로로 쌓는다.
          컨테이너는 클릭을 통과시키고(폭이 다른 두 자식 사이 빈 여백이 캔버스 pan/zoom을 가로채지 않도록),
          카드·Legend 각각에만 복원 — isEmpty 오버레이와 같은 패턴 */}
      <div className="pointer-events-none absolute bottom-3 right-3 z-20 flex flex-col items-end gap-2">
        {selectedEdge && (
          <div className="pointer-events-auto max-w-sm rounded-lg border px-3 py-2 text-xs"
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
        <Legend />
      </div>

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
        // 컨테이너는 클릭을 통과시키고(Legend 등 아래 요소가 계속 눌리도록), 카드에만 복원
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
             data-testid="ErdViewer-emptyState">
          <div className="pointer-events-auto max-w-md rounded-xl border p-8 text-center"
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
