"use client";

/** ERD 커스텀 노드 — 기본 접힘, 더블클릭 토글 / collapsed-by-default node card. */

import { Handle, Position } from "@xyflow/react";
import type { NodeProps, Node } from "@xyflow/react";

import { useI18n } from "@/components/i18n";
import { MAX_VISIBLE_COLUMNS } from "@/lib/layout";
import type { GraphNode } from "@/lib/types";

export interface TableNodeData extends Record<string, unknown> {
  node: GraphNode;
  expanded: boolean;
  isAnchor: boolean;
  onExpandNeighbors: (id: number) => void;
  onToggleNode: (id: number) => void;
  onSelectColumn: (columnId: number, columnName: string, objectQname: string) => void;
}

export type TableFlowNode = Node<TableNodeData, "tableNode">;

export function TableNode({ data }: NodeProps<TableFlowNode>) {
  const { t } = useI18n();
  const { node, expanded, isAnchor } = data;
  const isView = node.type === "view";
  const collapsed = !expanded;
  const visibleColumns = node.columns.slice(0, MAX_VISIBLE_COLUMNS);
  const hiddenCount = node.columns.length - visibleColumns.length;

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
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />

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
          {collapsed ? "▸" : "▾"}
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
          {visibleColumns.map((col) => (
            <div
              key={col.id}
              className={`erd-node__row cursor-pointer hover:bg-black/5 ${col.is_pk ? "erd-node__row--pk" : ""}`}
              onClick={() =>
                data.onSelectColumn(col.id, col.name, `${node.schema}.${node.name}`)}
              data-testid={`ErdNode-columnRow-${col.id}`}
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
            <div className="erd-node__meta">
              {t("erd.moreColumns").replace("{n}", String(hiddenCount))}
            </div>
          )}
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
