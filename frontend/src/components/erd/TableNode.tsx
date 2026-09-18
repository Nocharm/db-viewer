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
  /** null이면 읽기 전용 — 이웃 확장 버튼 자체를 렌더하지 않는다 / null hides the expand button */
  onExpandNeighbors: ((id: number) => void) | null;
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
// 줘야 한다. 드롭은 connectionRadius 기반 최근접 탐색이라 관대하지만, 드래그 시작만은
// 핸들 엘리먼트가 직접 pointerdown을 받아야 하므로 여기 크기가 곧 조작 가능 여부다.
// / column-row handles are BOTH the edge-docking anchor and the user's drag grip. A
// zero-size handle, or one sitting on the scroll container's clip boundary (the default
// left:0/right:0 + translate ±50% puts it exactly there), makes elementFromPoint resolve
// to the parent .erd-node div instead — drag-to-join silently never starts. Dropping is
// forgiving (nearest-handle within connectionRadius), but starting a drag requires a real
// pointerdown on the handle element, so this box is what decides whether joining works.
const COLUMN_HANDLE_INSET = 3; // px — 클립 경계 안쪽 여유 (엣지 도킹 위치도 이만큼만 안쪽으로 이동)
const COLUMN_HANDLE_WIDTH = 12; // px — 실제 드래그 그립 폭 (10–14px 권장 범위)
// 높이는 반드시 명시한다 — 기본 .react-flow__handle의 height:6px가 살아 있으면 top/bottom을
// 둘 다 줘도 CSS over-constrained 규칙에 따라 bottom이 무시되어 22px 행의 위 6px만 잡힌다
// (실측: 행 세로 중앙의 elementFromPoint가 .erd-node__row를 반환 → 드래그 시작 불가).
// / height must be explicit: the stylesheet's height:6px wins over a top+bottom pair (CSS
// drops `bottom` when over-constrained), leaving only the top 6px of a 22px row grabbable.
const COLUMN_HANDLE_BASE_STYLE = {
  top: 0,
  height: "100%",
  boxSizing: "border-box",
  width: COLUMN_HANDLE_WIDTH,
} as const;
const COLUMN_HANDLE_LEFT_STYLE = {
  ...COLUMN_HANDLE_BASE_STYLE,
  left: COLUMN_HANDLE_INSET,
  transform: "none", // 기본 .react-flow__handle-left의 translate(-50%,-50%) 상쇄
} as const;
const COLUMN_HANDLE_RIGHT_STYLE = {
  ...COLUMN_HANDLE_BASE_STYLE,
  right: COLUMN_HANDLE_INSET,
  transform: "none", // 기본 .react-flow__handle-right의 translate(50%,-50%) 상쇄
} as const;

// 한 번에 그리는 컬럼 수 — 수백 컬럼 테이블을 통째로 그리면 프레임이 끊긴다
// (TableList·AdUserList와 같은 청크 패턴) / rows rendered per chunk
const RENDER_CHUNK = 60;

export function TableNode({ id, data }: NodeProps<TableFlowNode>) {
  const { t } = useI18n();
  const updateNodeInternals = useUpdateNodeInternals();
  const { node, expanded, isAnchor, highlightColumns, onExpandNeighbors } = data;
  const isView = node.type === "view";
  const collapsed = !expanded;
  const highlight = highlightColumns ? new Set(highlightColumns) : null;

  const [visibleCount, setVisibleCount] = useState(RENDER_CHUNK);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // 배열 identity가 아니라 내용으로 스크롤 이펙트를 트리거 — 부모가 매 렌더 새 배열을 넘겨도 안전
  const highlightKey = highlightColumns?.join(",") ?? "";

  // 접었다 펴면 처음 청크부터 / restart chunking when re-expanded
  useEffect(() => {
    if (collapsed) setVisibleCount(RENDER_CHUNK);
  }, [collapsed]);

  // 하이라이트가 살아 있는 동안 첫 하이라이트 행을 스크롤 뷰포트로 — 펼침 전환(드래그 중
  // 자동 펼침·딥링크 자동 펼침)과 이미 펼쳐진 노드의 하이라이트 교체(엣지 호버 컬럼 내비)를
  // 모두 덮는다. 60행 청크 안이라도 대략 20행 밑은 스크롤 없이는 안 보인다.
  // scroll the first highlighted row into view whenever a highlight is active — covers both
  // the collapsed→expanded transitions (drag hover, deep link) and a highlight swap on an
  // already-expanded node (edge-hover column navigation).
  useEffect(() => {
    if (!expanded || highlightKey === "") return;
    const row = scrollRef.current?.querySelector<HTMLElement>(".erd-node__row--hl");
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [expanded, highlightKey]);

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
      data-testid={`ErdCanvas-node-${node.id}`}
    >
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />

      {/* 더블클릭 토글은 헤더 한정 — 컬럼 행은 선택(onSelectColumn)이 있어 겹치면 안 된다.
          select-none은 더블클릭이 헤더 텍스트를 선택 반전시키는 것을 막는다 */}
      <div
        className="erd-node__header select-none"
        // 호버 툴팁에 조작법을 적는다 — 커서(pointer)만으로는 우클릭 메뉴의 존재가 안 보인다
        title={node.ai_summary ? `${node.ai_summary}\n\n${t("erd.headerHint")}` : t("erd.headerHint")}
        onDoubleClick={() => data.onToggleNode(node.id)}
        data-testid={`ErdNode-header-${node.id}`}
      >
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
        {onExpandNeighbors && (
          <button
            className="icon-button"
            data-testid={`ErdNode-expandButton-${node.id}`}
            onClick={() => onExpandNeighbors(node.id)}
            title={t("erd.expandNeighbors")}
          >
            +
          </button>
        )}
      </div>

      {!collapsed && (
        <div>
          <div
            ref={scrollRef}
            // nowheel = React Flow가 이 영역의 휠을 줌으로 가로채지 않는다(공식 이스케이프
            // 해치). 없으면 컬럼 목록 위에서 굴려도 목록이 아니라 캔버스가 확대·축소된다
            // / nowheel keeps the wheel with the column list instead of the canvas zoom
            className="erd-node__scroll scroll-area nowheel"
            onScroll={reportVisible}
            data-testid={`ErdNode-columnScroll-${node.id}`}
          >
            {shown.map((col) => (
              <div
                key={col.id}
                data-column-name={col.name}
                className={[
                  // 호버 틴트는 globals.css .erd-node__row:hover — black/5는 다크에서 안 보였다
                  "erd-node__row relative cursor-pointer",
                  col.is_pk ? "erd-node__row--pk" : "",
                  highlight?.has(col.name) ? "erd-node__row--hl" : "",
                ].join(" ")}
                onClick={() =>
                  data.onSelectColumn(col.id, col.name, `${node.schema}.${node.name}`)}
                data-testid={`ErdNode-columnRow-${col.id}`}
              >
                {/* 컬럼 행이 조인 드래그의 출발·도착점 — .erd-handle이 행 hover 시 그립 바를
                    드러낸다(globals.css) / column rows are join endpoints; .erd-handle reveals
                    the grip bar on row hover */}
                <Handle type="target" position={Position.Left} id={`t-${col.name}`}
                        isConnectable className="erd-handle" style={COLUMN_HANDLE_LEFT_STYLE} />
                <Handle type="source" position={Position.Right} id={`s-${col.name}`}
                        isConnectable className="erd-handle" style={COLUMN_HANDLE_RIGHT_STYLE} />
                <span className="truncate">
                  {col.is_pk && <span className="pk-mark">PK</span>}
                  {col.name}
                  {col.is_computed ? " ƒ" : ""}
                </span>
                {/* 타입은 줄바꿈·축소 금지 — 좁아지면 컬럼명 쪽 truncate가 흡수해 행이 한 줄로 남는다
                    / the type never wraps or shrinks; the name's truncate absorbs the squeeze */}
                <span className="erd-node__type shrink-0 whitespace-nowrap">
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
