"use client";

/** ERD 커스텀 노드 — 기본 접힘, 펼치면 전체 컬럼을 내부 스크롤로 본다.
 * node card with column handles; expanded nodes scroll internally. */

import { useEffect, useRef, useState } from "react";
import { Handle, Position, useUpdateNodeInternals } from "@xyflow/react";
import type { NodeProps, Node } from "@xyflow/react";

import { CaretDownIcon, CaretRightIcon } from "@/components/icons";
import { useI18n } from "@/components/i18n";
import type { GraphNode } from "@/lib/types";

export interface TableNodeData extends Record<string, unknown> {
  node: GraphNode;
  expanded: boolean;
  isAnchor: boolean;
  /** 호버 강조·조인 추천으로 강조된 컬럼명 / columns to highlight */
  highlightColumns: string[] | null;
  onExpandNeighbors: (id: number) => void;
  onToggleNode: (id: number) => void;
  onSelectColumn: (columnId: number, columnName: string, objectQname: string) => void;
  /** 스크롤 뷰포트 안의 컬럼 보고 — 엣지 앵커 해석에 쓰인다 */
  onVisibleColumnsChange: (nodeId: number, columns: string[]) => void;
}

export type TableFlowNode = Node<TableNodeData, "tableNode">;

// 핸들은 지름 1px 투명 — 선 정렬용 좌표만 제공 (노드 헤더 좌우 핸들 전용, 컬럼 행은 아래 참고)
// / invisible coordinate-only handles (header handles only — column rows use the style below)
const HANDLE_STYLE = { opacity: 0, width: 1, height: 1, minWidth: 1, minHeight: 1 } as const;

// 컬럼 행 핸들은 두 역할을 겸한다 — 엣지가 도킹하는 좌표 AND 사용자가 드래그를 시작하는 그립.
// 크기 0에 가깝거나 스크롤 컨테이너(.erd-node__scroll, overflow-y: auto)의 클리핑 경계에
// 걸쳐 있으면(기본 Handle은 left:0/right:0 + translate ±50%로 정확히 그 경계 위에 앉는다)
// document.elementFromPoint가 핸들 대신 부모 .erd-node div를 반환해 드래그가 시작조차 안 된다 —
// 브라우저 실측으로만 잡힌 회귀라 정적 검사로는 못 본다. 경계 안쪽으로 들이고 실제 히트박스를
// 줘야 한다. opacity: 0은 유지 — 컬럼 행 자체가 어포던스이며 점을 노출하지 않는다.
// / column-row handles are BOTH the edge-docking anchor and the user's drag grip. A
// zero-size handle, or one sitting on the scroll container's clip boundary (the default
// left:0/right:0 + translate ±50% puts it exactly there), makes elementFromPoint resolve
// to the parent .erd-node div instead — drag-to-join silently never starts. Fixed by
// insetting inside the clip box with a real hit width; do not shrink this back to a dot.
const COLUMN_HANDLE_INSET = 3; // px — 클립 경계 안쪽 여유 (엣지 도킹 위치도 이만큼만 안쪽으로 이동)
const COLUMN_HANDLE_WIDTH = 12; // px — 실제 드래그 그립 폭 (10–14px 권장 범위)
const COLUMN_HANDLE_LEFT_STYLE = {
  opacity: 0,
  top: 0,
  bottom: 0,
  left: COLUMN_HANDLE_INSET,
  width: COLUMN_HANDLE_WIDTH,
  transform: "none", // 기본 .react-flow__handle-left의 translate(-50%,-50%) 상쇄
} as const;
const COLUMN_HANDLE_RIGHT_STYLE = {
  opacity: 0,
  top: 0,
  bottom: 0,
  right: COLUMN_HANDLE_INSET,
  width: COLUMN_HANDLE_WIDTH,
  transform: "none", // 기본 .react-flow__handle-right의 translate(50%,-50%) 상쇄
} as const;

// 한 번에 그리는 컬럼 수 — 수백 컬럼 테이블을 통째로 그리면 프레임이 끊긴다
// (TableList·AdUserList와 같은 청크 패턴) / rows rendered per chunk
const RENDER_CHUNK = 60;

export function TableNode({ id, data }: NodeProps<TableFlowNode>) {
  const { t } = useI18n();
  const updateNodeInternals = useUpdateNodeInternals();
  const { node, expanded, isAnchor, highlightColumns } = data;
  const isView = node.type === "view";
  const collapsed = !expanded;
  const highlight = highlightColumns ? new Set(highlightColumns) : null;

  const [visibleCount, setVisibleCount] = useState(RENDER_CHUNK);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const wasExpandedRef = useRef(expanded);

  // 접었다 펴면 처음 청크부터 / restart chunking when re-expanded
  useEffect(() => {
    if (collapsed) setVisibleCount(RENDER_CHUNK);
  }, [collapsed]);

  // 접힘→펼침 전환 + 하이라이트 존재 시 첫 하이라이트 행을 스크롤 뷰포트로 (스펙 §1.2.3,
  // 이번까지 미구현) — 드래그 중 자동 펼침(ErdCanvas onNodeMouseEnter)과 딥링크 자동 펼침
  // (Finding A) 둘 다 여길 통과한다. highlightColumns는 순수 hover 강조(엣지·노드 hover)에도
  // 쓰이지만 그건 expanded를 건드리지 않으므로 전환 여부로 가드하면 hover 스크롤은 안 섞인다.
  // 60행 청크 아래(대략 20행 밑)는 펼쳐도 스크롤 없인 안 보인다는 게 원래 결함이었다.
  // scroll the first highlighted row into view on a collapsed→expanded transition while a
  // highlight is active (spec §1.2.3, never implemented before now) — covers both the
  // drag-hover auto-expand path (ErdCanvas onNodeMouseEnter) and the deep-link auto-expand
  // (Finding A). highlightColumns is also set by plain hover emphasis (edge/node hover),
  // but that never touches `expanded`, so gating on the transition keeps hover scrolling
  // out of this. Without it, a candidate below roughly row 20 stayed invisible even expanded.
  useEffect(() => {
    const justExpanded = expanded && !wasExpandedRef.current;
    wasExpandedRef.current = expanded;
    if (!justExpanded || !highlightColumns || highlightColumns.length === 0) return;
    const row = scrollRef.current?.querySelector<HTMLElement>(".erd-node__row--hl");
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [expanded, highlightColumns]);

  // 바닥 도달 → 다음 청크 / append the next chunk at the bottom
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || visibleCount >= node.columns.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((current) => current + RENDER_CHUNK);
        }
      },
      { root: scrollRef.current },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visibleCount, node.columns.length]);

  // 접기/펼치기·청크 증가로 핸들 구성이 바뀌면 React Flow에 재측정 통지
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, expanded, visibleCount, updateNodeInternals]);

  // 스크롤 뷰포트 안의 컬럼을 보고 — 밖으로 나간 행은 엣지가 헤더로 폴백한다
  // report which rows are inside the viewport so edges can fall back to the header
  const reportVisible = () => {
    const container = scrollRef.current;
    if (!container) return;
    const top = container.scrollTop;
    const bottom = top + container.clientHeight;
    const inView: string[] = [];
    for (const row of Array.from(container.querySelectorAll<HTMLElement>("[data-column-name]"))) {
      // offsetTop은 container가 offsetParent일 때만 이 프레임과 일치한다
      // (globals.css .erd-node__scroll의 position: relative에 의존 — 지우면 어긋난다)
      if (row.offsetTop + row.offsetHeight > top && row.offsetTop < bottom) {
        inView.push(row.dataset.columnName ?? "");
      }
    }
    data.onVisibleColumnsChange(node.id, inView);
  };

  useEffect(() => {
    if (collapsed) {
      data.onVisibleColumnsChange(node.id, []);
      return;
    }
    reportVisible();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 렌더된 행이 바뀔 때만 재보고
  }, [collapsed, visibleCount, node.id]);

  const shown = node.columns.slice(0, visibleCount);

  return (
    <div
      className={[
        "erd-node",
        isView ? "erd-node--view" : "",
        isAnchor ? "erd-node--selected" : "",
      ].join(" ")}
      onDoubleClick={() => data.onToggleNode(node.id)}
      data-testid={`ErdCanvas-node-${node.id}`}
    >
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />

      <div className="erd-node__header" title={node.ai_summary ?? undefined}>
        <span className="erd-node__type">{isView ? "VIEW" : "TBL"}</span>
        <span className="flex-1 truncate">{node.schema}.{node.name}</span>
        {/* 접힘 상태에서도 규모가 보이게 / column count visible while folded */}
        {collapsed && (
          <span className="erd-node__type">{node.columns.length}c</span>
        )}
        {node.ai_summary && <span className="badge badge--ai">AI</span>}
        <button
          className="icon-button"
          data-testid={`ErdNode-toggleButton-${node.id}`}
          onClick={() => data.onToggleNode(node.id)}
          title={collapsed ? t("erd.expandColumns") : t("erd.collapseColumns")}
        >
          {collapsed ? <CaretRightIcon size={11} /> : <CaretDownIcon size={11} />}
        </button>
        <button
          className="icon-button"
          data-testid={`ErdNode-expandButton-${node.id}`}
          onClick={() => data.onExpandNeighbors(node.id)}
          title={t("erd.expandNeighbors")}
        >
          +
        </button>
      </div>

      {!collapsed && (
        <div>
          <div
            ref={scrollRef}
            className="erd-node__scroll scroll-area"
            onScroll={reportVisible}
            data-testid={`ErdNode-columnScroll-${node.id}`}
          >
            {shown.map((col) => (
              <div
                key={col.id}
                data-column-name={col.name}
                className={[
                  "erd-node__row relative cursor-pointer hover:bg-black/5",
                  col.is_pk ? "erd-node__row--pk" : "",
                  highlight?.has(col.name) ? "erd-node__row--hl" : "",
                ].join(" ")}
                onClick={() =>
                  data.onSelectColumn(col.id, col.name, `${node.schema}.${node.name}`)}
                data-testid={`ErdNode-columnRow-${col.id}`}
              >
                {/* 컬럼 행이 조인 드래그의 출발·도착점 / column rows are join endpoints */}
                <Handle type="target" position={Position.Left} id={`t-${col.name}`}
                        isConnectable style={COLUMN_HANDLE_LEFT_STYLE} />
                <Handle type="source" position={Position.Right} id={`s-${col.name}`}
                        isConnectable style={COLUMN_HANDLE_RIGHT_STYLE} />
                <span className="truncate">
                  {col.is_pk && <span className="pk-mark">PK</span>}
                  {col.name}
                  {col.is_computed ? " ƒ" : ""}
                </span>
                <span className="erd-node__type">
                  {col.data_type}
                  {col.is_nullable ? "" : " *"}
                </span>
              </div>
            ))}
            {visibleCount < node.columns.length && (
              <div ref={sentinelRef} className="erd-node__meta"
                   data-testid={`ErdNode-columnSentinel-${node.id}`}>
                {t("erd.moreColumns")
                  .replace("{n}", String(node.columns.length - visibleCount))}
              </div>
            )}
          </div>
          <div className="erd-node__meta flex gap-1 flex-wrap items-center">
            {node.row_count !== null && <span>{node.row_count.toLocaleString()} rows</span>}
            {node.dmv_unresolved && <span className="badge badge--unresolved">DMV</span>}
            {node.lineage_flag && (
              <span className="badge badge--unresolved">{node.lineage_flag}</span>
            )}
            {node.unresolved_dep_count > 0 && (
              <span className="badge badge--unresolved">
                {t("erd.unresolved")} {node.unresolved_dep_count}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
