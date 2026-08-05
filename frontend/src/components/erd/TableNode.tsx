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

// 핸들은 지름 1px 투명 — 선 정렬용 좌표만 제공 / invisible coordinate-only handles
const HANDLE_STYLE = { opacity: 0, width: 1, height: 1, minWidth: 1, minHeight: 1 } as const;

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

  // 접었다 펴면 처음 청크부터 / restart chunking when re-expanded
  useEffect(() => {
    if (collapsed) setVisibleCount(RENDER_CHUNK);
  }, [collapsed]);

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
                        isConnectable style={HANDLE_STYLE} />
                <Handle type="source" position={Position.Right} id={`s-${col.name}`}
                        isConnectable style={HANDLE_STYLE} />
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
