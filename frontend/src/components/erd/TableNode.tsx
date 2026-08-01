"use client";

/** ERD 커스텀 노드 — 테이블/뷰 카드 / custom React Flow node for tables and views. */

import { Handle, Position } from "@xyflow/react";
import type { NodeProps, Node } from "@xyflow/react";

import { MAX_VISIBLE_COLUMNS } from "@/lib/layout";
import type { GraphNode } from "@/lib/types";

export interface TableNodeData extends Record<string, unknown> {
  node: GraphNode;
  viewExpanded: boolean;
  isAnchor: boolean;
  onExpandNeighbors: (id: number) => void;
  onToggleView: (id: number) => void;
}

export type TableFlowNode = Node<TableNodeData, "tableNode">;

export function TableNode({ data }: NodeProps<TableFlowNode>) {
  const { node, viewExpanded, isAnchor } = data;
  const isView = node.type === "view";
  const collapsed = isView && !viewExpanded;
  const visibleColumns = node.columns.slice(0, MAX_VISIBLE_COLUMNS);
  const hiddenCount = node.columns.length - visibleColumns.length;

  return (
    <div
      className={[
        "erd-node",
        isView ? "erd-node--view" : "",
        isAnchor ? "erd-node--selected" : "",
      ].join(" ")}
      data-testid={`ErdCanvas-node-${node.id}`}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />

      <div className="erd-node__header">
        <span className="erd-node__type">{isView ? "VIEW" : "TBL"}</span>
        <span className="flex-1 truncate">{node.schema}.{node.name}</span>
        {isView && (
          <button
            className="icon-button"
            data-testid={`ErdNode-toggleButton-${node.id}`}
            onClick={() => data.onToggleView(node.id)}
            title={collapsed ? "컬럼 펼치기" : "접기"}
          >
            {collapsed ? "▸" : "▾"}
          </button>
        )}
        <button
          className="icon-button"
          data-testid={`ErdNode-expandButton-${node.id}`}
          onClick={() => data.onExpandNeighbors(node.id)}
          title="이웃 1-hop 확장"
        >
          +
        </button>
      </div>

      {!collapsed && (
        <div>
          {visibleColumns.map((col) => (
            <div
              key={col.id}
              className={`erd-node__row ${col.is_pk ? "erd-node__row--pk" : ""}`}
            >
              <span className="truncate">
                {col.is_pk ? "🔑 " : ""}
                {col.name}
                {col.is_computed ? " ⚙" : ""}
              </span>
              <span className="erd-node__type">
                {col.data_type}
                {col.is_nullable ? "" : " *"}
              </span>
            </div>
          ))}
          {hiddenCount > 0 && (
            <div className="erd-node__meta">… 외 {hiddenCount}개 컬럼</div>
          )}
          <div className="erd-node__meta flex gap-1 flex-wrap items-center">
            {node.row_count !== null && <span>{node.row_count.toLocaleString()} rows</span>}
            {node.dmv_unresolved && <span className="badge badge--unresolved">DMV</span>}
            {node.lineage_flag && (
              <span className="badge badge--unresolved">{node.lineage_flag}</span>
            )}
            {node.unresolved_dep_count > 0 && (
              <span className="badge badge--unresolved">
                미해석 {node.unresolved_dep_count}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
