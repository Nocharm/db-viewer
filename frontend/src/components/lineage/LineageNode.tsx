"use client";

/** 계보 맵의 노드 카드 — 세 지도(소스 흐름·컬럼 계보·영향도)가 같은 카드를 쓴다.
 * ERD의 TableNode와 달리 컬럼을 펼치지 않는다: 여기 실리는 컬럼은 "이 맥락에서 실제로
 * 쓰이는 것"뿐이라 이미 짧다. / one card for all three maps; columns are context-scoped. */

import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";

import { CaretDownIcon, CaretRightIcon, TableIcon, ViewIcon } from "@/components/icons";
import type { LineageNodeData } from "@/lib/api";

export interface LineageNodePayload extends Record<string, unknown> {
  node: LineageNodeData;
  /** 맵의 기준 객체인가 — 테두리를 브랜드 색으로 세워 시선을 준다 */
  isRoot: boolean;
  /** 호버 세션에서 강조 대상인가 (null = 호버 세션 없음 → 전부 보통) */
  emphasis: "on" | "off" | null;
  /** 강조할 컬럼명 — 컬럼 계보 탭에서 한 컬럼을 집었을 때 */
  highlightColumns: string[] | null;
  /** 컬럼 행에 붙일 표시 — derived는 계산식(ƒ), unresolved는 카탈로그 밖 소스(!) */
  columnMarks: Record<string, "derived" | "unresolved"> | null;
  /** 위에 나열된 컬럼이 무엇인가 — "used"면 이 맥락에서 쓰이는 것만 추린 것이라 나머지는
   * 「미사용」이고, "all"이면 애초에 추리지 않은 것이라 펼침은 그냥 「전체 컬럼」이다.
   * 구분하지 않으면 소스 흐름 탭의 뷰 노드가 자기 출력 컬럼을 "미사용"이라 부른다 */
  columnRole: "used" | "all";
  /** 컬럼 행마다 핸들을 다는가 — 컬럼 계보 탭에서만 참 */
  columnHandles: boolean;
  /** 미사용 컬럼까지 펼쳤는가 */
  expanded: boolean;
  /** 이 맥락에서 안 쓰는 컬럼 — null이면 아직 안 받아왔다(펼칠 때 조회) */
  unusedColumns: string[] | null;
  /** 미사용 컬럼 조회 중 */
  loadingColumns: boolean;
  /** 접힘/펼침 토글 — 카드 클릭이 부른다 */
  onToggleExpand: (qname: string) => void;
}

export type LineageFlowNode = Node<LineageNodePayload, "lineageNode">;

/** 좌표 전용 핸들 — 보이지 않고 드래그 연결도 쓰지 않는다(읽기 전용 맵) */
const HANDLE_STYLE = {
  opacity: 0, width: 1, height: 1, minWidth: 1, minHeight: 1, border: "none",
} as const;

const TYPE_COLOR: Record<LineageNodeData["type"], string> = {
  table: "var(--hairline-strong)",
  view: "var(--obj-view)",
  unresolved: "var(--rel-unresolved)",
};

function formatCount(value: number | null): string | null {
  return value === null ? null : value.toLocaleString();
}

export function LineageNode({ data }: NodeProps<LineageFlowNode>) {
  const {
    node, isRoot, emphasis, highlightColumns, columnMarks, columnHandles, columnRole,
    expanded, unusedColumns, loadingColumns, onToggleExpand,
  } = data;
  const dimmed = emphasis === "off";
  const lit = emphasis === "on";
  const accent = TYPE_COLOR[node.type];
  const rows = formatCount(node.row_count);
  const cols = formatCount(node.column_count);
  // 미사용 컬럼 수는 카탈로그 전체 컬럼 수에서 뺀다 — 펼치기 전에도 "몇 개가 숨어 있나"를 말한다
  const hiddenCount = node.column_count === null
    ? null
    : Math.max(0, node.column_count - (columnRole === "used" ? node.columns.length : 0));
  const canExpand = node.id !== null && (hiddenCount === null || hiddenCount > 0);

  return (
    <div
      className="lineage-node"
      data-lit={lit || undefined}
      style={{
        borderColor: isRoot ? "var(--primary)" : lit ? accent : "var(--hairline)",
        borderWidth: isRoot || lit ? 2 : 1,
        opacity: dimmed ? 0.3 : 1,
      }}
      data-testid={`LineageNode-${node.qname}`}
    >
      {/* 4방향 좌표 핸들 — 레인 간 간선은 좌우, 같은 레인 안 JOIN 간선은 상하를 쓴다
          (같은 x끼리 좌우로 이으면 카드 위를 되감아 지나간다) */}
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} isConnectable={false} />
      <Handle type="target" id="top" position={Position.Top} style={HANDLE_STYLE} isConnectable={false} />
      <Handle type="source" id="bottom" position={Position.Bottom} style={HANDLE_STYLE} isConnectable={false} />

      <div className="lineage-node__header">
        {node.type === "view" ? (
          <ViewIcon size={11} style={{ color: accent, flexShrink: 0 }} />
        ) : (
          <TableIcon size={11}
                     style={{ color: node.type === "unresolved" ? accent : "var(--muted)", flexShrink: 0 }} />
        )}
        <span className="lineage-node__name" title={node.qname}>{node.qname}</span>
      </div>
      <div className="lineage-node__meta">
        {node.type === "unresolved"
          ? <span style={{ color: "var(--rel-unresolved)" }}>카탈로그 밖</span>
          : (
            <>
              {rows !== null && <span>{rows} rows</span>}
              {cols !== null && <span>{cols} cols</span>}
              {node.depth > 0 && <span>depth {node.depth}</span>}
            </>
          )}
      </div>

      {(node.columns.length > 0 || canExpand) && (
        <div className="lineage-node__columns scroll-area">
          {node.columns.map((column) => {
            const on = highlightColumns?.includes(column) ?? false;
            const mark = columnMarks?.[column] ?? null;
            return (
              <div
                key={column}
                className="lineage-node__row"
                data-on={on || undefined}
                data-testid={`LineageNode-col-${node.qname}-${column}`}
              >
                {columnHandles && (
                  <>
                    <Handle
                      type="target" position={Position.Left} id={`in:${column}`}
                      style={HANDLE_STYLE} isConnectable={false}
                    />
                    <Handle
                      type="source" position={Position.Right} id={`out:${column}`}
                      style={HANDLE_STYLE} isConnectable={false}
                    />
                  </>
                )}
                <span className="truncate">{column}</span>
                {mark === "derived" && (
                  <span className="lineage-node__mark" style={{ color: "var(--code-fn)" }}
                        title="계산식 — 원본 값 그대로가 아니다">ƒ</span>
                )}
                {mark === "unresolved" && (
                  <span className="lineage-node__mark" style={{ color: "var(--rel-unresolved)" }}
                        title="카탈로그 밖 소스">!</span>
                )}
              </div>
            );
          })}

          {/* 분류 경계 — 위는 이 맥락에서 쓰이는 컬럼, 아래는 나머지 */}
          {canExpand && (
            <button
              type="button"
              className="lineage-node__more"
              onClick={(event) => { event.stopPropagation(); onToggleExpand(node.qname); }}
              aria-expanded={expanded}
              data-testid={`LineageNode-expand-${node.qname}`}
            >
              {expanded ? <CaretDownIcon size={9} /> : <CaretRightIcon size={9} />}
              <span>
                {loadingColumns
                  ? "…"
                  : expanded
                    ? "접기"
                    : `${columnRole === "used" ? "미사용" : "전체 컬럼"} `
                      + `${hiddenCount === null ? "" : hiddenCount}`}
              </span>
            </button>
          )}
          {expanded && unusedColumns !== null && unusedColumns.map((column) => (
            <div
              key={`unused:${column}`}
              className="lineage-node__row lineage-node__row--unused"
              data-testid={`LineageNode-unused-${node.qname}-${column}`}
            >
              <span className="truncate">{column}</span>
            </div>
          ))}
          {expanded && unusedColumns !== null && unusedColumns.length === 0 && (
            <div className="lineage-node__row lineage-node__row--unused">
              <span className="truncate">
                {columnRole === "used" ? "전 컬럼 사용 중" : "컬럼 없음"}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
