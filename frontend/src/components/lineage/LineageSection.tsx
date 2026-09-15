"use client";

/** 계보 다이어그램 섹션 — 테이블 상세의 아코디언 본문. 네 지도를 탭으로 묶는다.
 *
 * 탭이 같은 섹션 안에 있는 이유: 소스 흐름 → 컬럼 계보 → 정의 SQL은 같은 뷰를 점점 깊이
 * 보는 한 흐름이라, 화면을 옮기면 "어디를 보던 중이었나"가 끊긴다. 데이터도 한 번만 받는다.
 * / one payload, one canvas, four views of it — switching tabs never refetches.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Edge } from "@xyflow/react";

import { useI18n } from "@/components/i18n";
import { InfoTip } from "@/components/InfoTip";
import { LineageCanvas } from "@/components/lineage/LineageCanvas";
import type { LineageFlowNode } from "@/components/lineage/LineageNode";
import { SqlPane } from "@/components/lineage/SqlPane";
import {
  fetchImpactGraph, fetchObjectDetail, fetchViewDiagram,
  type ImpactGraph, type LineageNodeData, type ViewDiagram,
} from "@/lib/api";
import {
  assignColumnLineageLanes, assignImpactLanes, assignSourceFlowLanes, JOIN_LANE_GAP,
  layoutLanes, type RowCountResolver,
} from "@/lib/lineage-graph";
import { useDeferredHover } from "@/lib/use-deferred-hover";

/** 캔버스 높이(px) — 상세 패널 안에 들어가면서 3~4레인이 한눈에 잡히는 실측 높이 */
const CANVAS_HEIGHT = 420;

export type LineageTab = "source" | "columns" | "sql" | "impact";

/** 출력 컬럼 매핑이 없는 계보 행 — Phase 1 카탈로그 수준(`view_column='*'`) */
const SET_LEVEL_COLUMN = "*";

interface Props {
  objectId: number;
  qname: string;
  objectType: "table" | "view";
  /** 노드 팝오버의 「상세 열기」 — 상세 패널의 선택을 바꾼다 */
  onSelectTable: (qname: string) => void;
}

interface MapRoot {
  id: number;
  qname: string;
  type: "table" | "view";
}

export function LineageSection({ objectId, qname, objectType, onSelectTable }: Props) {
  const { t } = useI18n();
  const [root, setRoot] = useState<MapRoot>({ id: objectId, qname, type: objectType });
  // 재루팅 이력 — 「돌아가기」로 되짚는다. 맵 안에서 길을 잃지 않게 하는 유일한 장치
  const [trail, setTrail] = useState<MapRoot[]>([]);
  const [diagram, setDiagram] = useState<ViewDiagram | null>(null);
  const [impact, setImpact] = useState<ImpactGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<LineageTab>(objectType === "view" ? "source" : "impact");
  const [pickedColumn, setPickedColumn] = useState<string | null>(null);
  // 미사용 컬럼을 펼친 노드들. 컬럼 목록은 펼칠 때 한 번만 받아 캐시한다 — 맵 페이로드에
  // 전 컬럼을 실으면 영향도 80노드 × 수백 컬럼이 초기 응답에 그대로 붙는다.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [allColumns, setAllColumns] = useState<Map<string, string[]>>(new Map());
  const [loadingColumns, setLoadingColumns] = useState<Set<string>>(new Set());

  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [hoverSql, setHoverSql] = useState<string[]>([]);
  const settledNode = useDeferredHover(hoverNode);
  // 빈 배열도 "호버 없음"이다 — null로 바꿔 넘겨야 해제 지연이 적용된다
  const settledSql = useDeferredHover(hoverSql.length > 0 ? hoverSql : null);

  // 상세에서 다른 객체를 고르면 맵도 그 객체로 리셋한다 — 이력이 남으면 남의 경로가 된다
  useEffect(() => {
    setRoot({ id: objectId, qname, type: objectType });
    setTrail([]);
    setTab(objectType === "view" ? "source" : "impact");
    setPickedColumn(null);
    setExpanded(new Set());
  }, [objectId, qname, objectType]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setDiagram(null);
    setImpact(null);
    const wanted: Promise<unknown>[] = [
      fetchImpactGraph(root.id).then((res) => { if (alive) setImpact(res); }),
    ];
    if (root.type === "view") {
      wanted.push(fetchViewDiagram(root.id).then((res) => { if (alive) setDiagram(res); }));
    }
    Promise.all(wanted)
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [root.id, root.type]);

  const toggleExpand = useCallback((nodeQname: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(nodeQname)) next.delete(nodeQname);
      else next.add(nodeQname);
      return next;
    });
  }, []);

  const focusNode = useCallback((node: LineageNodeData) => {
    if (node.id === null || node.type === "unresolved") return;
    setTrail((current) => [...current, root]);
    setRoot({ id: node.id, qname: node.qname, type: node.type });
    setTab(node.type === "view" ? "source" : "impact");
    setPickedColumn(null);
  }, [root]);

  const goBack = useCallback(() => {
    setTrail((current) => {
      const previous = current[current.length - 1];
      if (previous) {
        setRoot(previous);
        setTab(previous.type === "view" ? "source" : "impact");
        setPickedColumn(null);
      }
      return current.slice(0, -1);
    });
  }, []);

  // 펼쳐졌는데 아직 전 컬럼을 모르는 노드를 채운다. 실패해도 조용히 둔다 —
  // 펼침은 부가 정보라 오류 배너로 맵 전체를 덮을 일이 아니다(카드에 "…"만 남는다).
  const nodeIdByQname = useMemo(() => {
    const map = new Map<string, number>();
    for (const node of diagram?.nodes ?? []) if (node.id !== null) map.set(node.qname, node.id);
    for (const node of impact?.nodes ?? []) if (node.id !== null) map.set(node.qname, node.id);
    return map;
  }, [diagram, impact]);

  useEffect(() => {
    const pending = [...expanded].filter(
      (key) => !allColumns.has(key) && nodeIdByQname.has(key));
    if (pending.length === 0) return;
    let alive = true;
    setLoadingColumns((current) => new Set([...current, ...pending]));
    for (const key of pending) {
      const id = nodeIdByQname.get(key) as number;
      fetchObjectDetail(id)
        .then((detail) => {
          if (!alive) return;
          setAllColumns((current) =>
            new Map(current).set(key, detail.columns.map((column) => column.name)));
        })
        .catch(() => undefined)
        .finally(() => {
          if (!alive) return;
          setLoadingColumns((current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
          });
        });
    }
    return () => { alive = false; };
  }, [expanded, allColumns, nodeIdByQname]);

  /** 노드 하나의 미사용 컬럼 — 카탈로그 전 컬럼에서 이 맥락의 사용 컬럼을 뺀다 */
  const getUnusedColumns = useCallback((node: LineageNodeData): string[] | null => {
    const every = allColumns.get(node.qname);
    if (every === undefined) return null;
    const used = new Set(node.columns);
    return every.filter((column) => !used.has(column));
  }, [allColumns]);

  /** 레이아웃이 쓰는 행 수 — 펼치면 구분 버튼 1행 + 미사용 컬럼만큼 늘고, 그만큼
   * 같은 레인의 아래 노드가 밀려난다(간격 자동 조절) */
  const resolveRows = useCallback<RowCountResolver>((node) => {
    const isOpen = expanded.has(node.qname);
    const hasMore = node.id !== null
      && (node.column_count === null || node.column_count > node.columns.length);
    const unused = isOpen ? (getUnusedColumns(node)?.length ?? 1) : 0;
    return {
      rowCount: node.columns.length + (hasMore ? 1 : 0) + unused,
      expanded: isOpen,
    };
  }, [expanded, getUnusedColumns]);

  // ── 지도별 노드·간선 ────────────────────────────────────────────────────────
  const viewNodeData = useMemo<LineageNodeData | null>(() => {
    if (diagram === null) return null;
    const { view } = diagram;
    return {
      id: view.id, qname: view.qname, schema: view.schema, type: "view", depth: 0,
      direct: true, row_count: view.row_count, column_count: view.column_count,
      ai_summary: view.ai_summary, hidden: false, columns: [],
    };
  }, [diagram]);

  /** 컬럼 계보에 실제로 쓸 수 있는 출력 컬럼 — set 수준 행은 컬럼 매핑이 없다 */
  const mappedColumns = useMemo(
    () => (diagram?.columns ?? []).filter(
      (column) => column.name !== SET_LEVEL_COLUMN && column.sources.length > 0),
    [diagram],
  );

  const graph = useMemo(() => buildGraph({
    tab, diagram, impact, viewNodeData, root, pickedColumn, mappedColumns,
    emphasisNames: settledSql, expanded, getUnusedColumns, loadingColumns,
    onToggleExpand: toggleExpand, resolveRows,
  }), [
    tab, diagram, impact, viewNodeData, root, pickedColumn, mappedColumns, settledSql,
    expanded, getUnusedColumns, loadingColumns, toggleExpand, resolveRows,
  ]);

  /** SQL 패널이 물들일 이름 — 맵에서 호버한 노드의 qname과 그 노드가 쓰는 컬럼 */
  const sqlHighlight = useMemo(() => {
    if (settledNode === null) return [];
    const node = graph.nodes.find((n) => n.id === settledNode);
    if (!node) return [settledNode];
    return [node.data.node.qname, ...node.data.node.columns];
  }, [settledNode, graph.nodes]);

  /** SQL 줄에서 찾아볼 이름 후보 — 맵에 있는 객체명 + 컬럼명 전부 */
  const candidateNames = useMemo(() => {
    const names = new Set<string>();
    for (const node of graph.nodes) {
      names.add(node.data.node.qname);
      for (const column of node.data.node.columns) names.add(column);
    }
    return [...names];
  }, [graph.nodes]);

  /** SQL 호버 → 카메라가 찾아갈 노드 (첫 일치) */
  const focusKey = useMemo(() => {
    if (settledSql === null) return null;
    const hit = graph.nodes.find((node) =>
      settledSql.includes(node.data.node.qname)
      || node.data.node.columns.some((column) => settledSql.includes(column)));
    return hit?.id ?? null;
  }, [settledSql, graph.nodes]);

  const tabs: { key: LineageTab; label: string; tip: string; enabled: boolean }[] = [
    {
      key: "source", label: t("lineage.tabSource"), tip: t("lineage.tipSource"),
      enabled: root.type === "view",
    },
    {
      key: "columns", label: t("lineage.tabColumns"), tip: t("lineage.tipColumns"),
      enabled: root.type === "view",
    },
    {
      key: "sql", label: t("lineage.tabSql"), tip: t("lineage.tipSql"),
      enabled: root.type === "view" && (diagram?.view.definition ?? null) !== null,
    },
    { key: "impact", label: t("lineage.tabImpact"), tip: t("lineage.tipImpact"), enabled: true },
  ];

  const visibleTabs = tabs.filter((item) => item.enabled);
  const sql = diagram?.view.definition ?? null;

  return (
    <section className="card mb-7 p-0" data-testid="LineageSection-root">
      <div className="lineage-bar">
        {trail.length > 0 && (
          <button className="icon-button" onClick={goBack} data-testid="LineageSection-backButton">
            ← {t("lineage.back")}
          </button>
        )}
        <code className="lineage-bar__root" title={root.qname}>{root.qname}</code>
        <span className={`badge ${root.type === "view" ? "badge--view" : "badge--muted"}`}>
          {root.type === "view" ? "VIEW" : "TABLE"}
        </span>
        {diagram?.view.parse_status && (
          <span
            className={`badge ${diagram.view.parse_status === "ok" ? "badge--ok" : "badge--warn"}`}
            title={diagram.view.parse_error ?? undefined}
            data-testid="LineageSection-parseStatus"
          >
            parse {diagram.view.parse_status}
          </span>
        )}
        {impact?.truncated && (
          <span className="badge badge--warn" data-testid="LineageSection-truncated">
            {t("lineage.truncated")}
          </span>
        )}
        <div className="lineage-bar__tabs">
          <div role="tablist" aria-label={t("lineage.title")} className="flex gap-0.5">
            {visibleTabs.map((item) => (
              <button
                key={item.key}
                role="tab"
                aria-selected={tab === item.key}
                className="lineage-tab"
                onClick={() => setTab(item.key)}
                data-testid={`LineageSection-tab-${item.key}`}
              >
                {item.label}
              </button>
            ))}
          </div>
          {/* 탭 우측 ⓘ — 네 탭이 각각 무엇을 보여주는지와 조작법을 한 자리에 모은다.
              말풍선은 body로 포털되므로 캔버스 경계에 잘리지 않는다 */}
          <span data-testid="LineageSection-tabsHelp">
            <InfoTip text={t("lineage.tabsHelp")} align="left" maxWidth={440}>
              <span className="lineage-help">
                {visibleTabs.map((item) => (
                  <span key={item.key} className="lineage-help__row">
                    <b>{item.label}</b>
                    <span>{item.tip}</span>
                  </span>
                ))}
                <span className="lineage-help__row lineage-help__row--foot">
                  <b>{t("lineage.helpControls")}</b>
                  <span>{t("lineage.tipCanvas")}</span>
                </span>
              </span>
            </InfoTip>
          </span>
        </div>
      </div>

      <div className="p-3">
        {error !== null ? (
          <p className="text-sm" style={{ color: "var(--error)" }}
             data-testid="LineageSection-error">{error}</p>
        ) : loading ? (
          <div className="skeleton" style={{ height: CANVAS_HEIGHT }} role="status"
               aria-label={t("common.loading")} data-testid="LineageSection-loading" />
        ) : graph.nodes.length === 0 ? (
          <p className="hint-pill" data-testid="LineageSection-empty">{graph.emptyHint}</p>
        ) : tab === "sql" && sql !== null ? (
          <div className="lineage-split">
            <SqlPane
              sql={sql}
              highlightNames={sqlHighlight}
              candidateNames={candidateNames}
              onHoverNames={setHoverSql}
              height={CANVAS_HEIGHT}
            />
            <LineageCanvas
              nodes={graph.nodes} edges={graph.edges} focusKey={focusKey}
              onHoverNode={setHoverNode} onToggleExpand={toggleExpand}
              onFocusNode={focusNode}
              onOpenObject={(node) => onSelectTable(node.qname)}
              rootKey={root.qname} height={CANVAS_HEIGHT}
            />
          </div>
        ) : (
          <LineageCanvas
            nodes={graph.nodes} edges={graph.edges} focusKey={null}
            onHoverNode={setHoverNode} onToggleExpand={toggleExpand}
            onFocusNode={focusNode}
            onOpenObject={(node) => onSelectTable(node.qname)}
            rootKey={root.qname} height={CANVAS_HEIGHT}
          />
        )}

        {tab === "columns" && mappedColumns.length > 0 && (
          <div className="lineage-picker" data-testid="LineageSection-columnPicker">
            <span className="lineage-picker__label">{t("lineage.pickColumn")}</span>
            <button
              className={`key-chip ${pickedColumn === null ? "key-chip--selected" : ""}`}
              onClick={() => setPickedColumn(null)}
            >
              {t("lineage.allColumns")}
            </button>
            {mappedColumns.map((column) => (
              <button
                key={column.name}
                className={`key-chip ${pickedColumn === column.name ? "key-chip--selected" : ""}`}
                onClick={() => setPickedColumn(
                  pickedColumn === column.name ? null : column.name)}
                data-testid={`LineageSection-column-${column.name}`}
              >
                {column.name}
                {column.kind === "derived" && (
                  <span style={{ color: "var(--code-fn)", marginLeft: 4 }}>ƒ</span>
                )}
              </button>
            ))}
          </div>
        )}

        {tab === "columns" && diagram !== null && mappedColumns.length === 0 && (
          <p className="hint-pill mt-2" data-testid="LineageSection-setLevelNotice">
            {t("lineage.setLevelOnly")}
          </p>
        )}

        <p className="lineage-legend">{graph.hint}</p>
      </div>
    </section>
  );
}

// ── 그래프 조립 ────────────────────────────────────────────────────────────────

interface BuildArgs {
  tab: LineageTab;
  diagram: ViewDiagram | null;
  impact: ImpactGraph | null;
  viewNodeData: LineageNodeData | null;
  root: MapRoot;
  pickedColumn: string | null;
  mappedColumns: ViewDiagram["columns"];
  emphasisNames: string[] | null;
  expanded: Set<string>;
  getUnusedColumns: (node: LineageNodeData) => string[] | null;
  loadingColumns: Set<string>;
  onToggleExpand: (qname: string) => void;
  resolveRows: RowCountResolver;
}

interface BuiltGraph {
  nodes: LineageFlowNode[];
  edges: Edge[];
  hint: string;
  emptyHint: string;
}

const EDGE_NEUTRAL = { stroke: "var(--rel-lineage)", strokeWidth: 1.5 };
const EDGE_VIEW = { stroke: "var(--obj-view)", strokeWidth: 1.5 };
const EDGE_JOIN = { stroke: "var(--rel-confirmed)", strokeWidth: 1.8 };
const EDGE_DERIVED = { stroke: "var(--code-fn)", strokeWidth: 1.5, strokeDasharray: "5 4" };
const EDGE_BAD = { stroke: "var(--rel-unresolved)", strokeWidth: 1.5, strokeDasharray: "5 4" };

function buildGraph(args: BuildArgs): BuiltGraph {
  const { tab, diagram, viewNodeData, root, pickedColumn, mappedColumns } = args;
  if (tab === "impact") return buildImpact(args);
  if (diagram === null || viewNodeData === null) {
    return { nodes: [], edges: [], hint: "", emptyHint: "뷰 정보를 받지 못했다." };
  }
  if (tab === "columns") {
    return buildColumnLineage(diagram, viewNodeData, mappedColumns, pickedColumn, args);
  }
  return buildSourceFlow(diagram, viewNodeData, root, args);
}

/** 호버한 SQL 줄의 이름과 겹치는가 — 겹치면 강조, 아니면 흐림. 호버 세션이 없으면 null. */
function resolveEmphasis(
  node: LineageNodeData, names: string[] | null,
): "on" | "off" | null {
  if (names === null) return null;
  const hit = names.includes(node.qname)
    || node.columns.some((column) => names.includes(column));
  return hit ? "on" : "off";
}

function toFlowNodes(
  data: LineageNodeData[],
  placed: ReturnType<typeof layoutLanes>,
  opts: {
    rootKey: string;
    emphasisNames: string[] | null;
    columnHandles: boolean;
    args: BuildArgs;
    highlightColumns?: Map<string, string[]>;
    columnMarks?: Map<string, Record<string, "derived" | "unresolved">>;
  },
): LineageFlowNode[] {
  const byKey = new Map(placed.map((item) => [item.key, item]));
  return data.flatMap((node) => {
    const position = byKey.get(node.qname);
    if (position === undefined) return [];
    return [{
      id: node.qname,
      type: "lineageNode" as const,
      position: { x: position.x, y: position.y },
      width: position.width,
      height: position.height,
      draggable: false,
      data: {
        node,
        isRoot: node.qname === opts.rootKey,
        emphasis: resolveEmphasis(node, opts.emphasisNames),
        highlightColumns: opts.highlightColumns?.get(node.qname) ?? null,
        columnMarks: opts.columnMarks?.get(node.qname) ?? null,
        columnHandles: opts.columnHandles,
        expanded: opts.args.expanded.has(node.qname),
        unusedColumns: opts.args.expanded.has(node.qname)
          ? opts.args.getUnusedColumns(node)
          : null,
        loadingColumns: opts.args.loadingColumns.has(node.qname),
        onToggleExpand: opts.args.onToggleExpand,
      },
    }];
  });
}

/** 제안 1·3 — FROM·JOIN 한 줄. 직접 소스만 그린다(중첩 뷰 너머는 컬럼 계보 탭 담당). */
function buildSourceFlow(
  diagram: ViewDiagram, viewNode: LineageNodeData, root: MapRoot, args: BuildArgs,
): BuiltGraph {
  const sources = diagram.nodes.filter((node) => node.direct);
  // JOIN으로 묶인 소스를 나란히 세운다 — 상하 간선이 이웃끼리 붙어야 조건이 읽힌다
  const order = orderByJoinAdjacency(sources.map((node) => node.qname), diagram.joins);
  const ordered = order.flatMap((key) => {
    const found = sources.find((node) => node.qname === key);
    return found ? [found] : [];
  });

  const placed = layoutLanes(
    assignSourceFlowLanes(ordered, viewNode.qname, args.resolveRows), JOIN_LANE_GAP);
  const nodes = toFlowNodes([...ordered, viewNode], placed, {
    rootKey: root.qname, emphasisNames: args.emphasisNames, columnHandles: false, args,
  });

  const edges: Edge[] = ordered.map((node) => ({
    id: `src:${node.qname}`,
    source: node.qname,
    target: viewNode.qname,
    style: node.type === "unresolved" ? EDGE_BAD : EDGE_VIEW,
    label: node.columns.length > 0 ? `${node.columns.length}컬럼` : undefined,
    labelStyle: { fontSize: 10, fill: "var(--muted)" },
    labelBgStyle: { fill: "var(--surface-card)" },
    labelBgPadding: [4, 2] as [number, number],
  }));

  const present = new Set(ordered.map((node) => node.qname));
  diagram.joins.forEach((join, index) => {
    if (!present.has(join.left_object) || !present.has(join.right_object)) return;
    edges.push({
      id: `join:${index}`,
      source: join.left_object,
      sourceHandle: "bottom",
      target: join.right_object,
      targetHandle: "top",
      type: "smoothstep",
      style: EDGE_JOIN,
      label: `${join.join_type.toUpperCase()} · ${join.left_column} = ${join.right_column}`,
      labelStyle: { fontSize: 10, fill: "var(--ink)" },
      labelBgStyle: { fill: "var(--surface-card)", stroke: "var(--hairline-strong)" },
      labelBgPadding: [6, 3] as [number, number],
    });
  });

  return {
    nodes,
    edges,
    hint: `직접 소스 ${ordered.length} · JOIN ${diagram.joins.length}`,
    emptyHint: "이 뷰의 참조를 해석하지 못했다 — 수집 시 의존성 DMV가 막혔을 수 있다.",
  };
}

/** JOIN으로 이어진 소스가 이웃하도록 정렬 — 나머지는 원래 순서를 지킨다. */
function orderByJoinAdjacency(keys: string[], joins: ViewDiagram["joins"]): string[] {
  const remaining = new Set(keys);
  const result: string[] = [];
  for (const join of joins) {
    for (const side of [join.left_object, join.right_object]) {
      if (remaining.delete(side)) result.push(side);
    }
  }
  for (const key of keys) if (remaining.has(key)) result.push(key);
  return result;
}

/** 제안 2 — 출력 컬럼 ↔ base 컬럼. 가로 위치가 depth다. */
function buildColumnLineage(
  diagram: ViewDiagram,
  viewNode: LineageNodeData,
  columns: ViewDiagram["columns"],
  picked: string | null,
  args: BuildArgs,
): BuiltGraph {
  const shown = picked === null ? columns : columns.filter((c) => c.name === picked);
  const columnsByObject = new Map<string, Set<string>>();
  for (const column of shown) {
    for (const source of column.sources) {
      if (source.column === null) continue;
      const bucket = columnsByObject.get(source.object) ?? new Set<string>();
      bucket.add(source.column);
      columnsByObject.set(source.object, bucket);
    }
  }

  const byQname = new Map(diagram.nodes.map((node) => [node.qname, node]));
  const sourceNodes: LineageNodeData[] = [...columnsByObject.entries()].map(
    ([objectQname, cols]) => {
      const known = byQname.get(objectQname);
      return {
        ...(known ?? {
          id: null, qname: objectQname, schema: null, type: "unresolved" as const, depth: 1,
          direct: false, row_count: null, column_count: null, ai_summary: null, hidden: false,
        }),
        columns: [...cols].sort(),
      };
    });

  const outputColumns = shown.map((column) => column.name);
  const marks: Record<string, "derived" | "unresolved"> = {};
  for (const column of shown) if (column.kind === "derived") marks[column.name] = "derived";
  const viewWithOutputs: LineageNodeData = { ...viewNode, columns: outputColumns };

  const placed = layoutLanes(assignColumnLineageLanes(
    sourceNodes, viewNode.qname, outputColumns.length, args.resolveRows));
  const nodes = toFlowNodes([...sourceNodes, viewWithOutputs], placed, {
    rootKey: args.root.qname,
    emphasisNames: args.emphasisNames,
    columnHandles: true,
    args,
    columnMarks: new Map([[viewNode.qname, marks]]),
  });

  const edges: Edge[] = [];
  for (const column of shown) {
    for (const source of column.sources) {
      if (source.column === null) continue;
      edges.push({
        id: `col:${source.object}.${source.column}->${column.name}`,
        source: source.object,
        sourceHandle: `out:${source.column}`,
        target: viewNode.qname,
        targetHandle: `in:${column.name}`,
        style: column.kind === "derived" ? EDGE_DERIVED : EDGE_NEUTRAL,
      });
    }
  }

  return {
    nodes,
    edges,
    hint: `출력 컬럼 ${columns.length} · 소스 객체 ${sourceNodes.length}`
      + (picked !== null ? ` · ${picked} 만 보는 중` : ""),
    emptyHint: "컬럼 단위 매핑이 없다 — 「소스 흐름」 탭에서 객체 수준으로 볼 수 있다.",
  };
}

/** 제안 4 — 이 객체를 읽는 뷰를 depth 순으로. 화살표는 데이터가 흐르는 방향. */
function buildImpact(args: BuildArgs): BuiltGraph {
  const { impact, root } = args;
  if (impact === null) {
    return { nodes: [], edges: [], hint: "", emptyHint: "영향도를 받지 못했다." };
  }
  const placed = layoutLanes(assignImpactLanes(impact.nodes, args.resolveRows));
  const nodes = toFlowNodes(impact.nodes, placed, {
    rootKey: root.qname, emphasisNames: args.emphasisNames, columnHandles: false, args,
  });
  const edges: Edge[] = impact.edges.map((edge, index) => ({
    id: `impact:${index}`,
    source: edge.from,
    target: edge.to,
    style: EDGE_VIEW,
    label: edge.columns.length > 0
      ? edge.columns.slice(0, 2).join(", ")
        + (edge.columns.length > 2 ? ` +${edge.columns.length - 2}` : "")
      : undefined,
    labelStyle: { fontSize: 10, fill: "var(--muted)" },
    labelBgStyle: { fill: "var(--surface-card)" },
    labelBgPadding: [4, 2] as [number, number],
  }));
  const consumers = impact.nodes.filter((node) => node.depth > 0).length;
  // 소비자가 없으면 루트 하나만 덩그러니 남는다 — 빈 화면으로 취급해 이유를 글로 말한다
  if (consumers === 0) {
    return {
      nodes: [], edges: [], hint: "",
      emptyHint: "이 객체를 읽는 뷰가 없다 — 지금 스냅샷 기준으로 소비처가 없다.",
    };
  }
  return {
    nodes,
    edges,
    hint: `영향받는 뷰 ${consumers}`,
    emptyHint: "이 객체를 읽는 뷰가 없다 — 지금 스냅샷 기준으로 소비처가 없다.",
  };
}
