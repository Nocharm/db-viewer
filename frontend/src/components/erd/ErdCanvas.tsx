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
import type { Connection, Edge, NodeChange } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { CloseIcon } from "@/components/icons";
import { useI18n } from "@/components/i18n";
import { PreviewSqlButton } from "@/components/PreviewSqlButton";
import { PreviewTable } from "@/components/PreviewTable";
import {
  fetchCandidates, fetchGraph, fetchObjectPreview, fetchScanJob, runContainment, runJoinPreview,
  startScan, type TablePreview,
} from "@/lib/api";
import { PAIR_KINDS, resolveEdgeHandles, type NodeAnchorInfo } from "@/lib/edge-anchors";
import { buildCsv, sortRows, type SortSpec } from "@/lib/preview-utils";
import { getCardinalityEnds, getEdgeVisual, MARKER_ID } from "@/lib/edge-style";
import { NODE_CONFIRM_THRESHOLD, planMerge, type MergePlan } from "@/lib/graph-merge";
import { estimateNodeSize, layoutGraph } from "@/lib/layout";
import {
  addStep, canAddStep, EMPTY_DRAFT, removeStep, setStepJoinType, setStepResult,
  type CanAddFailureReason, type JoinColumnRef, type JoinDraft, type JoinType,
} from "@/lib/join-draft";
import { getJoinVerdict, type JoinVerdict } from "@/lib/join-verdict";
import type { MessageKey } from "@/lib/i18n";
import type { GraphEdge, GraphResponse, JoinPreviewResponse } from "@/lib/types";
import { CardinalityMarkerDefs } from "@/components/erd/CardinalityMarkers";
import { JoinBuilder } from "@/components/erd/JoinBuilder";
import { JoinPreviewPanel } from "@/components/erd/JoinPreviewPanel";
import { TableNode, type TableFlowNode } from "./TableNode";
import { Legend } from "./Legend";

const nodeTypes = { tableNode: TableNode };

interface Props {
  anchorId: number | null;
  /** 딥링크로 들어온 컬럼 — 추천 하이라이트를 켠 채로 드래그를 기다린다 */
  initialColumnId?: number | null;
  onSelectColumn: (columnId: number, columnName: string, objectQname: string) => void;
  onQuickStart: (name: string) => void;
}

// 빈 캔버스 가이드용 예시 앵커 / quick-start suggestions for the empty state
const QUICK_START_ANCHORS = ["HR_EMP", "ORD_SO_HDR", "MES_BATCH_HDR", "V_CHAIN_05"];

// canAddStep의 코드형 거절 사유 → i18n 키 / rejection code from canAddStep to its i18n key
const REJECT_REASON_KEY: Record<CanAddFailureReason, MessageKey> = {
  same_table: "join.rejectSameTable",
  step_cap: "join.rejectStepCap",
  duplicate: "join.rejectDuplicate",
  disconnected: "join.rejectDisconnected",
};

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

function ErdCanvasInner({ anchorId, initialColumnId, onSelectColumn, onQuickStart }: Props) {
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
  const [draft, setDraft] = useState<JoinDraft>(EMPTY_DRAFT);
  const [joinPreview, setJoinPreview] = useState<JoinPreviewResponse | null>(null);
  const [joinPreviewError, setJoinPreviewError] = useState<string | null>(null);
  const [joinPreviewBusy, setJoinPreviewBusy] = useState(false);
  // 드래그 중 추천 컬럼 — T1 후보를 노드별로 묶어 하이라이트 / T1 candidates while dragging
  const [dragHint, setDragHint] = useState<Map<number, string[]> | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  // 추천이 0개일 때만 뜨는 전수 탐색 — 별도 블록이 아니라 추천의 보강 수단
  const [scanJobId, setScanJobId] = useState<number | null>(null);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  // ref가 아니라 state — 버튼 노출 여부가 렌더에 걸린다 / state, because it gates the render
  const [scanOrigin, setScanOrigin] = useState<JoinColumnRef | null>(null);
  // 스캔이 어떤 컬럼을 위해 시작됐는지 스냅샷 — scanOrigin은 다음 드래그가 덮어쓸 수 있어
  // 완료 시점에 그대로 읽으면 안 된다 / snapshot of the scan's target; scanOrigin state can be
  // overwritten by a later drag, so completion must not read it live
  const scanColumnIdRef = useRef<number | null>(null);
  const dragOriginRef = useRef<JoinColumnRef | null>(null);
  // 딥링크(?col=)를 이미 적용한 컬럼 id — 한 번만 켜져야 한다. graph는 expandNeighbors 등
  // 매 병합마다 새 참조를 받아 이걸 없이 [initialColumnId, graph]에만 걸면 무관한 노드를
  // 펼칠 때마다 하이라이트가 되살아난다 / tracks which deep-link column has already been
  // applied — graph gets a new identity on every merge (e.g. expand-neighbors), so without
  // this guard the effect would re-fire and re-highlight on any unrelated interaction
  const appliedInitialColumnIdRef = useRef<number | null>(null);
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

  /** 핸들 id("s-COL"/"t-COL")와 노드 id로 컬럼 참조를 만든다 / resolve a handle to a column ref. */
  const resolveHandle = useCallback(
    (nodeId: string | null, handleId: string | null): JoinColumnRef | null => {
      if (!nodeId || !handleId || !graph) return null;
      const objectId = Number(nodeId);
      const node = graph.nodes.find((n) => n.id === objectId);
      if (!node) return null;
      const columnName = handleId.slice(2); // "s-" / "t-" 접두 제거
      const column = node.columns.find((c) => c.name === columnName);
      if (!column) return null;
      return {
        objectId,
        qname: `${node.schema}.${node.name}`,
        columnId: column.id,
        column: column.name,
      };
    },
    [graph],
  );

  const handleConnectStart = useCallback(
    (_event: unknown, params: { nodeId: string | null; handleId: string | null }) => {
      setDropError(null);
      const origin = resolveHandle(params.nodeId, params.handleId);
      dragOriginRef.current = origin;
      if (!origin || !graph) return;
      // 드래그 시작 즉시 T1 후보 → 노드별 컬럼명으로 접어 하이라이트
      void fetchCandidates(origin.columnId)
        .then((res) => {
          // 드래그가 끝났거나 다른 컬럼으로 옮겨간 뒤 도착한 응답은 버린다 — 아니면 유휴 캔버스에
          // 지울 수 없는 낡은 하이라이트가 남는다 / drop late responses so they can't paint
          // stale highlights onto an ended (or since-moved) drag
          if (dragOriginRef.current?.columnId !== origin.columnId) return;
          const byNode = new Map<number, string[]>();
          for (const candidate of res.candidates) {
            const node = graph.nodes.find(
              (n) => `${n.schema}.${n.name}` === candidate.object);
            if (!node) continue;
            byNode.set(node.id, [...(byNode.get(node.id) ?? []), candidate.column]);
          }
          setDragHint(byNode);
          // 추천이 없을 때만 전수 탐색을 제안한다 / offer the scan only when nothing was found
          setScanOrigin(res.candidates.length === 0 ? origin : null);
        })
        .catch(() => {
          if (dragOriginRef.current?.columnId !== origin.columnId) return;
          setDragHint(new Map());
        });
    },
    [graph, resolveHandle],
  );

  const handleConnectEnd = useCallback(() => {
    dragOriginRef.current = null;
    // dragHint·scanOrigin은 유지 — 드래그를 놓은 뒤에도 추천·제안이 남는다
  }, []);

  // 딥링크(?col=) — 그 컬럼의 추천을 미리 켜 드래그 출발점을 알려준다. 1회성 의도라 이미
  // 적용한 컬럼이면 다시 켜지 않는다 — graph는 이웃 확장마다 새 참조를 받으므로 가드 없이
  // [initialColumnId, graph]에만 걸면 무관한 노드를 펼칠 때마다 되살아난다
  // deep link: pre-light the candidates so the user knows where to drag from. One-shot intent
  // — bail once this column has already been applied, since graph changes identity on every
  // neighbour expansion and a plain dependency on it would re-highlight forever
  useEffect(() => {
    if (!initialColumnId || !graph) return;
    if (appliedInitialColumnIdRef.current === initialColumnId) return;
    appliedInitialColumnIdRef.current = initialColumnId;
    void fetchCandidates(initialColumnId)
      .then((res) => {
        const byNode = new Map<number, string[]>();
        for (const candidate of res.candidates) {
          const node = graph.nodes.find((n) => `${n.schema}.${n.name}` === candidate.object);
          if (!node) continue;
          byNode.set(node.id, [...(byNode.get(node.id) ?? []), candidate.column]);
        }
        setDragHint(byNode);
      })
      .catch(() => undefined);
  }, [initialColumnId, graph]);

  // 스캔 폴링 — 완료·실패까지 1.5초 간격 (다른 비동기 작업과 동일한 폴링 관용)
  // scanJobId가 done/failed에서 null로 바뀌면 이 effect가 재실행되며 클린업이 먼저 돌아
  // 이전 인터벌을 지운다 — 완료된 잡이 폴러를 남기지 않는다 / cleared on every terminal path
  useEffect(() => {
    if (scanJobId === null) return;
    const timer = setInterval(() => {
      void fetchScanJob(scanJobId)
        .then((job) => {
          setScanProgress(job.progress);
          if (job.status !== "done" && job.status !== "failed") return;
          setScanJobId(null);
          setScanProgress(null);
          // 그 사이 다른 컬럼의 드래그가 시작됐으면(=활성 드래그가 스캔 대상과 다르면) 늦게
          // 도착한 결과가 그 드래그를 덮어쓰지 않도록 조용히 버린다 — handleConnectStart의
          // 라이브니스 가드와 같은 이유, 스캔은 그 창이 훨씬 길다. 드래그가 없으면(보통의
          // 경로 — 마우스를 놓은 뒤 백그라운드로 완료) 스캔이 여전히 유효한 대상이다.
          // if a different column's drag has since started, drop the stale results instead of
          // repainting over it — same reasoning as handleConnectStart's liveness guard, just
          // with a much longer window. No active drag (the normal path — the mouse was
          // released and the scan finishes in the background) still counts as valid.
          const staleDrag = dragOriginRef.current !== null
            && dragOriginRef.current.columnId !== scanColumnIdRef.current;
          if (staleDrag) return;
          if (job.status === "failed") {
            setScanNotice(job.error ?? t("ai.failed"));
            return;
          }
          if (job.results.length === 0) {
            setScanNotice(t("join.scanNone"));
            return;
          }
          // 찾아낸 컬럼을 추천 하이라이트로 합류시킨다 / merge hits into the drag hints
          const byNode = new Map<number, string[]>();
          for (const hit of job.results) {
            const node = (graph?.nodes ?? []).find(
              (n) => `${n.schema}.${n.name}` === hit.tgt_object);
            if (!node) continue;
            byNode.set(node.id, [...(byNode.get(node.id) ?? []), hit.tgt_column]);
          }
          setDragHint(byNode);
          setScanNotice(null);
        })
        .catch((e: Error) => {
          setScanJobId(null);
          setScanProgress(null);
          setScanNotice(e.message);
        });
    }, 1500);
    return () => clearInterval(timer);
  }, [scanJobId, graph, t]);

  // 부작용은 updater 밖에서 실행한다 — StrictMode가 updater를 두 번 호출해,
  // 안에 두면 runContainment(실 DB 질의)가 드롭마다 두 번 나간다.
  // side effects stay out of the setDraft updater — StrictMode double-invokes updaters,
  // and this one fires a live query against the source database.
  const handleConnect = useCallback((connection: Connection) => {
    const left = resolveHandle(connection.source, connection.sourceHandle);
    const right = resolveHandle(connection.target, connection.targetHandle);
    if (!left || !right) return;
    const check = canAddStep(draft, left, right);
    if (!check.ok) {
      const reasonText = t(REJECT_REASON_KEY[check.reason]).replace("{max}", String(check.max));
      setDropError(t("join.dropRejected").replace("{reason}", reasonText));
      // 거절 배너와 스캔 제안이 같은 자리를 다툰다 — 방금 액션에 대한 응답인 거절이 이긴다
      // (다음 드래그에서 다시 뜰 수 있어 제안 쪽을 접는다)
      // both banners compete for the same slot; the rejection — about the action just taken —
      // wins over the scan offer, which can reappear on the next drag
      setScanOrigin(null);
      return;
    }
    setDropError(null);
    // 스텝이 추가됐다 — 드래그 하이라이트·스캔 제안은 이번 드롭의 몫을 다했다
    setDragHint(null);
    setScanOrigin(null);
    // 위치가 아니라 컬럼 페어 키로 결과를 채운다 — 스텝이 배열 안에서 옮겨져도(제거로 인한
    // 인덱스 이동) 비동기 결과가 엉뚱한 스텝을 덮어쓰지 않는다
    // resolve by column-pair key, not position — a removal-induced index shift can't make this
    // async result land on the wrong step
    const stepKey = `${left.columnId}-${right.columnId}`;
    setDraft((current) => addStep(current, left, right));
    // 드롭 즉시 T2 자동 실행 — 단일 페어라 기존 검증과 같은 비용
    void runContainment(left.columnId, right.columnId)
      .then((result) => setDraft((latest) =>
        setStepResult(latest, stepKey, "ready", result, getJoinVerdict(result, null))))
      .catch((e: Error) => {
        // "no value data"(404)만 데이터 부재 — 그 외(500·401·네트워크 오류 등)는 검증
        // 자체가 실패한 것이라 같은 "값 없음" 문구로 뭉개면 실제 오류가 안 보인다
        // only a 404 means "no data"; every other failure (500, 401, network) is a
        // validation failure and must not be folded into the same "no data" copy
        if (e.message.includes("no value data")) {
          setDraft((latest) => setStepResult(
            latest, stepKey, "no_data", null, getJoinVerdict(null, null)));
          return;
        }
        const failedVerdict: JoinVerdict = {
          level: "danger",
          symptom: t("join.stepFailed").replace("{error}", e.message),
          remedy: null,
        };
        setDraft((latest) => setStepResult(latest, stepKey, "failed", null, failedVerdict));
      });
  }, [draft, resolveHandle, t]);

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

  // 빌더에 든 테이블 — 경로 강조의 기준 / tables currently in the draft
  const draftObjectIds = useMemo(() => {
    const ids = new Set<number>();
    for (const step of draft.steps) {
      ids.add(step.left.objectId);
      ids.add(step.right.objectId);
    }
    return ids;
  }, [draft]);

  // 강조 상태를 렌더에만 입힌다 — ELK 재배치 없이 / emphasis decorates render only, no relayout
  const displayNodes = useMemo(() => {
    const dimming = draftObjectIds.size > 0;
    if (!emphasis && !dragHint && !dimming) return flowNodes;
    return flowNodes.map((n) => {
      const id = Number(n.id);
      // 드래그 중에는 조인 추천이 호버 강조를 덮는다 / drag hints win over hover emphasis
      const columns = dragHint
        ? (dragHint.get(id) ?? null)
        : (emphasis?.columnsByNode.get(id) ?? null);
      // 조인 경로 밖은 낮춘다 — 드래그 중에는 대상 탐색을 방해하지 않도록 끈다
      const dimmed = dimming && !dragHint && !draftObjectIds.has(id);
      if (columns === null && n.data.highlightColumns === null && !dimmed) return n;
      return {
        ...n,
        style: dimmed ? { ...n.style, opacity: 0.15 } : { ...n.style, opacity: 1 },
        data: { ...n.data, highlightColumns: columns },
      };
    });
  }, [flowNodes, emphasis, dragHint, draftObjectIds]);

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
    const dimming = draftObjectIds.size > 0;
    if (!emphasis && !dimming) return anchoredEdges;
    return anchoredEdges.map((e) => {
      const inDraft = dimming
        && draftObjectIds.has(Number(e.source))
        && draftObjectIds.has(Number(e.target));
      // hover는 조인 경로 강조를 대체가 아니라 덧댄다 — 안 그러면 크라우드된 그래프를
      // 훑는 동안 조립 중인 경로가 사라진다(no-draft일 때는 inDraft가 항상 false라 무변화)
      // hover adds to the draft's path highlight rather than replacing it — otherwise
      // panning the mouse across a crowded graph makes the join-in-progress vanish
      // (inDraft is always false with no draft, so behaviour is unchanged there)
      const hit = emphasis ? (emphasis.edgeIds.has(e.id) || inDraft) : inDraft;
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
  }, [anchoredEdges, emphasis, draftObjectIds]);

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
        onNodeMouseEnter={(_event, node) => {
          buildNodeEmphasis(Number(node.id));
          // 드래그 중 접힌 노드에 들어오면 자동으로 펼쳐 컬럼 행을 드롭 대상으로 만든다
          // auto-expand a folded node under an active drag so its rows become drop targets
          if (!dragOriginRef.current) return;
          const id = Number(node.id);
          if (!expandedNodes.has(id)) toggleNode(id);
        }}
        onNodeMouseLeave={() => setEmphasis(null)}
        onConnectStart={handleConnectStart}
        onConnect={handleConnect}
        onConnectEnd={handleConnectEnd}
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

      {dropError && (
        <div
          className="absolute left-1/2 top-16 z-30 -translate-x-1/2 rounded-lg border px-3 py-1.5 text-xs"
          style={{ borderColor: "var(--error)", background: "var(--surface-card)",
                   color: "var(--error)" }}
          data-testid="ErdCanvas-dropError"
        >
          {dropError}
        </div>
      )}

      {scanOrigin && (
        <div
          className="absolute left-1/2 top-16 z-30 flex -translate-x-1/2 items-center gap-2
                     rounded-lg border px-3 py-1.5 text-xs"
          style={{ borderColor: "var(--hairline)", background: "var(--surface-card)" }}
          data-testid="ErdCanvas-findHidden"
        >
          <button
            className="btn-secondary !py-0.5 text-xs"
            disabled={scanJobId !== null}
            onClick={() => {
              setScanNotice(null);
              // 완료 시점에 비교할 스냅샷 — scanOrigin(state)은 그 사이 새 드래그가 덮어쓸 수 있다
              // snapshot to compare against at completion — scanOrigin (state) can be
              // overwritten by a newer drag before this job finishes
              scanColumnIdRef.current = scanOrigin.columnId;
              void startScan(scanOrigin.columnId)
                .then((res) => setScanJobId(res.job_id))
                .catch((e: Error) => setScanNotice(e.message));
            }}
            data-testid="ErdCanvas-findHiddenButton"
          >
            {t("join.findHidden")}
          </button>
          <span style={{ color: "var(--muted)" }}>
            {scanProgress
              ? t("join.scanRunning")
                  .replace("{done}", String(scanProgress.done))
                  .replace("{total}", String(scanProgress.total))
              : (scanNotice ?? t("join.findHiddenHint"))}
          </span>
        </div>
      )}
      <JoinBuilder
        draft={draft}
        onRemoveStep={(index) => setDraft((current) => removeStep(current, index))}
        onSetJoinType={(index: number, joinType: JoinType) =>
          setDraft((current) => setStepJoinType(current, index, joinType))}
        onClear={() => setDraft(EMPTY_DRAFT)}
        onPreview={() => {
          setJoinPreviewBusy(true);
          setJoinPreviewError(null);
          void runJoinPreview(draft.steps.map((s) => ({
            left_column_id: s.left.columnId,
            right_column_id: s.right.columnId,
            join_type: s.joinType,
          })))
            .then(setJoinPreview)
            .catch((e: Error) => setJoinPreviewError(e.message))
            .finally(() => setJoinPreviewBusy(false));
        }}
        previewBusy={joinPreviewBusy}
      />
      <JoinPreviewPanel
        result={joinPreview}
        error={joinPreviewError}
        busy={joinPreviewBusy}
        onClose={() => { setJoinPreview(null); setJoinPreviewError(null); }}
      />

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
