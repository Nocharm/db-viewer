"use client";

/** 공용 미리보기 테이블 — 헤더 우클릭(정렬·숨김·고유값 모달) / shared preview grid. */

import { useEffect, useRef, useState } from "react";

import { ArrowDownIcon, ArrowUpIcon, CloseIcon } from "@/components/icons";
import { useI18n } from "@/components/i18n";
import type { TablePreview } from "@/lib/api";
import {
  applyColumnOrder, countUniqueValues, moveColumn, sortRows, type SortSpec,
} from "@/lib/preview-utils";

interface Props {
  data: TablePreview;
  hidden: string[];
  sort: SortSpec | null;
  /** 드래그로 정한 컬럼 순서 — 빈 배열이면 원본 순서 / drag-defined order, empty = natural */
  order: string[];
  onToggleHidden: (column: string) => void;
  onSort: (sort: SortSpec | null) => void;
  onReorder: (order: string[]) => void;
  /** 셀 더블클릭 = 그 값으로 필터 — 미지정이면 비활성 / cell double-click quick filter */
  onQuickFilter?: (column: string, value: unknown) => void;
}

interface HeaderMenu {
  column: string;
  x: number;
  y: number;
}

// 컬럼 폭 드래그 한계(px) / drag clamp for column widths
const MIN_COL_WIDTH = 48;
const MAX_COL_WIDTH = 800;

export function PreviewTable({
  data, hidden, sort, order, onToggleHidden, onSort, onReorder, onQuickFilter,
}: Props) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<HeaderMenu | null>(null);
  const [uniqueColumn, setUniqueColumn] = useState<string | null>(null);
  // 헤더 드래그 순서 변경 — 드래그 중인 컬럼과 드롭 위치(대상 앞/뒤) 표시
  const [dragColumn, setDragColumn] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ column: string; after: boolean } | null>(null);
  // 세로선 드래그로 지정한 폭 — 더블클릭이 지우면 내용 맞춤(자연 폭)으로 복귀
  // dragged widths; double-click clears back to natural (content-fit) width
  const [widths, setWidths] = useState<Record<string, number>>({});
  const menuRef = useRef<HTMLDivElement | null>(null);

  // 다른 테이블 데이터로 바뀌면 폭 초기화 / reset widths when the object changes
  useEffect(() => {
    setWidths({});
  }, [data.object]);

  const startColumnResize = (event: React.PointerEvent, column: string) => {
    event.preventDefault();
    event.stopPropagation();
    const th = (event.currentTarget as HTMLElement).closest("th");
    if (!th) return;
    const startX = event.clientX;
    const startWidth = th.getBoundingClientRect().width;
    const onMove = (e: PointerEvent) => {
      const next = Math.min(Math.max(startWidth + (e.clientX - startX), MIN_COL_WIDTH), MAX_COL_WIDTH);
      setWidths((cur) => ({ ...cur, [column]: Math.round(next) }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // 지정 폭 컬럼은 말줄임 처리 / overridden columns ellipsize overflowing content
  const cellStyle = (column: string): React.CSSProperties | undefined => {
    const width = widths[column];
    if (width === undefined) return undefined;
    return { width, maxWidth: width, overflow: "hidden", textOverflow: "ellipsis" };
  };

  useEffect(() => {
    if (!menu) return;
    const handleClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menu]);

  const hiddenSet = new Set(hidden);
  // 순서는 숨김 컬럼까지 포함한 전체에 적용 — 드롭 결과를 저장할 때 숨김 컬럼의 상대
  // 위치가 보존된다 / the order spans hidden columns so their relative slots survive
  const orderedAll = applyColumnOrder(data.columns, order);
  const columns = orderedAll.filter((column) => !hiddenSet.has(column));
  const rows = sortRows(data.rows, sort);
  const uniqueItems = uniqueColumn ? countUniqueValues(data.rows, uniqueColumn) : [];

  const menuAction = (action: () => void) => {
    action();
    setMenu(null);
  };

  // 십자 하이라이트의 열 축 — React 상태로 두면 호버마다 500행 × N열이 리렌더된다.
  // 위임된 mouseover에서 셀 인덱스를 읽어 클래스만 토글한다 (행 축은 기존 tr:hover CSS).
  // / column axis of the crosshair: delegated mouseover toggles a class imperatively,
  //   since hover-in-state would re-render the whole grid on every move
  const tableRef = useRef<HTMLTableElement | null>(null);
  const hoverColIndexRef = useRef(-1);
  const setHoverColumnIndex = (index: number) => {
    if (hoverColIndexRef.current === index) return;
    const table = tableRef.current;
    if (!table) return;
    for (const cell of Array.from(table.querySelectorAll(".preview-col-hl"))) {
      cell.classList.remove("preview-col-hl");
    }
    if (index >= 0) {
      for (const row of Array.from(table.rows)) {
        if (row.cells.length <= 1) continue; // colspan 빈 상태 행은 열 개념이 없다
        row.cells[index]?.classList.add("preview-col-hl");
      }
    }
    hoverColIndexRef.current = index;
  };
  const handleTableMouseOver = (event: React.MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const cell = target?.closest("td, th");
    setHoverColumnIndex(cell instanceof HTMLTableCellElement ? cell.cellIndex : -1);
  };

  return (
    <>
      <table ref={tableRef} className="preview-table w-full text-xs"
             onMouseOver={handleTableMouseOver}
             onMouseLeave={() => setHoverColumnIndex(-1)}>
        <thead>
          <tr className="sticky top-0 text-left" style={{ background: "var(--surface-card)" }}>
            {columns.map((column) => (
              // 헤더 드래그 = 순서 변경. 드롭 위치는 마우스가 대상의 좌/우 절반 어디에
              // 있는지로 앞/뒤를 정한다 — 앞 삽입만으로는 맨 끝으로 못 보낸다
              // / drag to reorder; the target's midpoint decides before/after,
              //   since before-only insertion can never reach the last slot
              <th
                key={column}
                draggable
                className="relative cursor-context-menu whitespace-nowrap px-3 py-1.5 font-mono font-medium"
                style={{
                  ...cellStyle(column),
                  ...(dragColumn === column ? { opacity: 0.4 } : undefined),
                  ...(dropTarget?.column === column
                    ? { boxShadow: `inset ${dropTarget.after ? -2 : 2}px 0 0 var(--primary)` }
                    : undefined),
                }}
                onDragStart={(e) => {
                  setDragColumn(column);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  if (dragColumn === null || dragColumn === column) return;
                  e.preventDefault(); // drop 허용 / required to allow dropping
                  const rect = e.currentTarget.getBoundingClientRect();
                  const after = e.clientX > rect.x + rect.width / 2;
                  setDropTarget((cur) =>
                    cur?.column === column && cur.after === after ? cur : { column, after });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragColumn !== null && dropTarget !== null) {
                    onReorder(moveColumn(orderedAll, dragColumn, dropTarget.column, dropTarget.after));
                  }
                  setDragColumn(null);
                  setDropTarget(null);
                }}
                onDragEnd={() => {
                  setDragColumn(null);
                  setDropTarget(null);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ column, x: e.clientX, y: e.clientY });
                }}
                data-testid={`PreviewTable-header-${column}`}
              >
                {column}
                {sort?.column === column && (
                  <span className="ml-1 inline-block align-middle"
                        style={{ color: "var(--stat-ink)" }}>
                    {sort.dir === "asc" ? <ArrowUpIcon size={11} /> : <ArrowDownIcon size={11} />}
                  </span>
                )}
                {/* 세로선 핸들 — 드래그 폭 조절, 더블클릭 내용 맞춤 / drag to size, dbl-click to fit */}
                <span
                  className="col-resize"
                  draggable={false}
                  onPointerDown={(e) => startColumnResize(e, column)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setWidths((cur) => {
                      const next = { ...cur };
                      delete next[column];
                      return next;
                    });
                  }}
                  onContextMenu={(e) => e.stopPropagation()}
                  data-testid={`PreviewTable-resizeHandle-${column}`}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-t transition-colors duration-150 ease-in-out hover:bg-[var(--soft-stone)]"
                style={{ borderColor: "var(--hairline)" }}>
              {columns.map((column) => (
                <td key={column} className="whitespace-nowrap px-3 py-1"
                    style={cellStyle(column)}
                    title={String(row[column] ?? "")}
                    onDoubleClick={() => onQuickFilter?.(column, row[column])}>
                  {String(row[column] ?? "")}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="px-3 py-4" style={{ color: "var(--muted)" }}
                  colSpan={Math.max(columns.length, 1)} data-testid="PreviewTable-emptyState">
                {/* 필터가 없는데도 0행이면 원본이 비었다는 뜻 — 실행기 문제와 구분해 말한다 */}
                {data.filters.length > 0 || data.source !== "live"
                  ? t("preview.empty")
                  : t("preview.emptyLive")}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* 헤더 우클릭 메뉴 — 화면 좌표 고정 / header context menu at pointer */}
      {menu && (
        <div ref={menuRef} className="erd-menu !fixed" style={{ left: menu.x, top: menu.y }}
             data-testid="PreviewTable-headerMenu">
          <div className="erd-menu__label font-mono">{menu.column}</div>
          <button className="pressable erd-menu__item"
                  onClick={() => menuAction(() => onSort({ column: menu.column, dir: "asc" }))}
                  data-testid="PreviewTable-sortAscItem">
            {t("preview.sortAsc")} <ArrowUpIcon size={11} className="inline-block align-middle" />
          </button>
          <button className="pressable erd-menu__item"
                  onClick={() => menuAction(() => onSort({ column: menu.column, dir: "desc" }))}
                  data-testid="PreviewTable-sortDescItem">
            {t("preview.sortDesc")} <ArrowDownIcon size={11} className="inline-block align-middle" />
          </button>
          {sort !== null && (
            <button className="pressable erd-menu__item"
                    onClick={() => menuAction(() => onSort(null))}
                    data-testid="PreviewTable-clearSortItem">
              {t("preview.clearSort")}
            </button>
          )}
          <button className="pressable erd-menu__item"
                  onClick={() => menuAction(() => onToggleHidden(menu.column))}
                  data-testid="PreviewTable-hideColumnItem">
            {t("preview.hideColumn")}
          </button>
          <button className="pressable erd-menu__item"
                  onClick={() => menuAction(() => setUniqueColumn(menu.column))}
                  data-testid="PreviewTable-uniqueItem">
            {t("preview.uniqueValues")}
          </button>
        </div>
      )}

      {/* 고유값 모달 — 로드된 행 기준임을 명시 / unique-values modal, loaded-rows basis */}
      {uniqueColumn && (
        // 바깥 닫기는 mousedown 기준 — click은 mouseup에서 나므로 모달 안에서 누른 채
        // 밖으로 끌어 놓으면(텍스트 드래그 선택 등) 의도치 않게 닫힌다
        // close on mousedown; a click fires on mouseup and would close on drag-out
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
             onMouseDown={() => setUniqueColumn(null)}>
          <div
            className="flex max-h-[70vh] w-96 flex-col rounded-xl border p-4"
            style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-card)" }}
            onMouseDown={(e) => e.stopPropagation()}
            data-testid="PreviewTable-uniqueModal"
          >
            <div className="mb-1 flex items-center gap-2">
              <span className="font-mono text-sm font-semibold" style={{ color: "var(--ink)" }}>
                {uniqueColumn}
              </span>
              <span className="badge badge--muted">{uniqueItems.length}</span>
              <button className="icon-button ml-auto" onClick={() => setUniqueColumn(null)}
                      data-testid="PreviewTable-uniqueCloseButton">
                <CloseIcon />
              </button>
            </div>
            <p className="mb-2 text-xs" style={{ color: "var(--muted)" }}>
              {t("preview.uniqueBasis").replace("{n}", String(data.rows.length))}
            </p>
            <div className="scroll-area min-h-0 overflow-y-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left" style={{ color: "var(--muted)" }}>
                    <th className="py-1">{t("preview.valueHeader")}</th>
                    <th className="w-16 text-right">{t("preview.countHeader")}</th>
                  </tr>
                </thead>
                <tbody>
                  {uniqueItems.map(({ value, count }) => (
                    <tr key={value} className="border-t" style={{ borderColor: "var(--hairline)" }}>
                      <td className="max-w-64 truncate py-1 font-mono">{value || "∅"}</td>
                      <td className="text-right tabular-nums" style={{ color: "var(--stat-ink)" }}>
                        {count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
