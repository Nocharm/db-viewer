"use client";

/** 공용 미리보기 테이블 — 헤더 우클릭(정렬·숨김·고유값 모달) / shared preview grid. */

import { useEffect, useRef, useState } from "react";

import { ArrowDownIcon, ArrowUpIcon, CloseIcon } from "@/components/icons";
import { useI18n } from "@/components/i18n";
import type { TablePreview } from "@/lib/api";
import {
  applyColumnOrder, copyTextToClipboard, countUniqueValues, moveColumn, sortRows,
  type SortSpec,
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
  /** 그 값으로 필터 조건 추가(셀 더블클릭·고유값 메뉴) — 미지정이면 비활성.
   * op는 포함(eq)/제외(neq), 값이 null이면 IS NULL / IS NOT NULL로 내려간다
   * / stage a filter for that value; op picks include vs exclude */
  onQuickFilter?: (column: string, value: unknown, op?: "eq" | "neq") => void;
  /** 긴 값 표시 방식 — true면 자동 줄바꿈, false면 말줄임 / wrap long values instead of ellipsis */
  wrapCells: boolean;
  /** 계속 강조할 컬럼 — 조인 검증이 "지금 보는 컬럼"을 표시하는 데 쓴다(호버 십자와 별개)
   * / a column pinned as highlighted, independent of the hover crosshair */
  highlightColumn?: string | null;
}

interface HeaderMenu {
  column: string;
  x: number;
  y: number;
}

/** 고유값 모달에서 클릭한 값 + 메뉴 위치 / clicked value in the unique-values modal */
interface ValueMenu {
  value: string;
  x: number;
  y: number;
}

// 토스트 표시 시간(ms) — 읽고 지나갈 만큼만 / how long a toast stays up
const TOAST_MS = 2400;

// 컬럼 폭 드래그 한계(px) / drag clamp for column widths
const MIN_COL_WIDTH = 48;
// 상한은 「전문 한 줄」 맞춤이 실제로 도달할 수 있게 넉넉히 — 긴 텍스트 컬럼은
// 1,000px를 넘기도 한다 / high enough that fit-to-content can actually reach full text
const MAX_COL_WIDTH = 1600;
// 폭을 지정하지 않은 컬럼의 첫 렌더 상한(px) — 값이 긴 컬럼 하나가 표를 가로로
// 밀어내 첫 화면부터 못 읽게 되는 걸 막는다. 개별 조정은 헤더 경계 드래그·더블클릭
// / default cap so one long-valued column can't stretch the grid on first render
const DEFAULT_COL_WIDTH = 340;
// 줄바꿈 모드의 더블클릭 목표 줄 수 — 전문 폭을 이 수로 나눠 대략 3줄에서 끊는다
const WRAP_TARGET_LINES = 3;
// 단어 단위로 끊기며 줄 끝에 남는 여백 보정 — 정확히 3등분하면 한 줄이 더 생긴다(실측)
const WRAP_SLACK = 1.15;
// 줄바꿈 맞춤의 하한(px) — 3등분이 지나치게 좁아 단어마다 끊기는 걸 막는다
const WRAP_MIN_WIDTH = 140;
// 셀 좌우 패딩(px-3 = 24) + 여유 1px / cell padding plus a hair of slack
const CELL_PADDING_X = 26;
// 헤더의 정렬 화살표 자리(px) — 이름이 화살표에 가리지 않게 맞춤 폭에 더한다
const SORT_ICON_SPACE = 18;

/** 포인터 위치에 뜬 메뉴를 뷰포트 안으로 끌어들인다 — 미리보기는 화면 아래쪽이라
 * 클릭 지점 그대로 열면 항목이 화면 밖으로 잘린다
 * / pull a pointer-anchored menu back inside the viewport */
function useViewportClamp<T extends { x: number; y: number }>(
  position: T | null,
  ref: React.RefObject<HTMLDivElement | null>,
  setPosition: (next: T) => void,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!position || !el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.max(8, Math.min(position.x, window.innerWidth - rect.width - 8));
    const y = Math.max(8, Math.min(position.y, window.innerHeight - rect.height - 8));
    if (x !== position.x || y !== position.y) setPosition({ ...position, x, y });
  }, [position, ref, setPosition]);
}

export function PreviewTable({
  data, hidden, sort, order, onToggleHidden, onSort, onReorder, onQuickFilter, wrapCells,
  highlightColumn = null,
}: Props) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<HeaderMenu | null>(null);
  const [uniqueColumn, setUniqueColumn] = useState<string | null>(null);
  const [valueMenu, setValueMenu] = useState<ValueMenu | null>(null);
  // 토스트 — 같은 문구를 연속으로 띄워도 다시 뜨도록 id를 함께 든다
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  // 헤더 드래그 순서 변경 — 드래그 중인 컬럼과 드롭 위치(대상 앞/뒤) 표시
  const [dragColumn, setDragColumn] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ column: string; after: boolean } | null>(null);
  // 세로선 드래그·더블클릭으로 지정한 폭 — 없으면 DEFAULT_COL_WIDTH 상한을 쓴다
  // dragged or double-click-fitted widths; absent means the default cap applies
  const [widths, setWidths] = useState<Record<string, number>>({});
  const menuRef = useRef<HTMLDivElement | null>(null);
  const valueMenuRef = useRef<HTMLDivElement | null>(null);
  // 내용 실측용 캔버스 — DOM으로 재려면 말줄임·줄바꿈을 임시로 풀었다 되돌려야 해서
  // 레이아웃을 두 번 흔든다 / a canvas measures text without disturbing the layout
  const measureRef = useRef<CanvasRenderingContext2D | null>(null);

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

  // 드래그로 지정한 폭만 셀에 건다 / only dragged widths size the cell itself
  const cellStyle = (column: string): React.CSSProperties | undefined => {
    const width = widths[column];
    if (width === undefined) return undefined;
    return { width, maxWidth: width };
  };

  // 값 클리핑은 셀이 아니라 내부 블록이 맡는다 — auto 레이아웃 표는 td의 max-width를
  // 무시하고 내용만큼 열을 늘리기 때문 / an inner block caps the content's preferred width
  const contentStyle = (column: string): React.CSSProperties => {
    const width = widths[column];
    // 폭 값은 셀 패딩을 포함한 「컬럼 폭」이다 — 내부 블록엔 패딩을 뺀 값을 줘야 글자가
    // 옆 컬럼까지 번지지 않는다 / the stored width includes padding; the inner block gets
    // the remainder so text never bleeds past the cell
    const inner = Math.max((width ?? DEFAULT_COL_WIDTH) - CELL_PADDING_X, MIN_COL_WIDTH);
    if (wrapCells) {
      // 줄바꿈 열의 min-content는 「가장 긴 단어」라, 컬럼이 많아 표가 포화되면 auto
      // 레이아웃이 지정 폭을 무시하고 컬럼명 폭까지 눌러버린다. width+minWidth를 같이
      // 걸어 지정 폭을 열의 최소 기여폭으로 만들면 더블클릭·드래그가 실제로 먹는다
      // / a wrappable column's min-content is its longest word, so a saturated table
      //   squeezes it back to the header; width+minWidth pins the chosen width instead
      return width !== undefined
        ? { width: inner, minWidth: inner, maxWidth: inner,
            whiteSpace: "normal", wordBreak: "break-word" }
        // 폭 미지정이어도 한 단어 폭까지 쪼그라들지 않게 하한을 준다
        : { minWidth: WRAP_MIN_WIDTH - CELL_PADDING_X, maxWidth: inner,
            whiteSpace: "normal", wordBreak: "break-word" };
    }
    return { maxWidth: inner, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
  };

  useEffect(() => {
    if (!menu) return;
    const handleClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menu]);

  useEffect(() => {
    if (!valueMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (!valueMenuRef.current?.contains(e.target as Node)) setValueMenu(null);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [valueMenu]);

  useViewportClamp(menu, menuRef, setMenu);
  useViewportClamp(valueMenu, valueMenuRef, setValueMenu);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const showToast = (text: string) =>
    setToast((cur) => ({ id: (cur?.id ?? 0) + 1, text }));

  const hiddenSet = new Set(hidden);
  // 순서는 숨김 컬럼까지 포함한 전체에 적용 — 드롭 결과를 저장할 때 숨김 컬럼의 상대
  // 위치가 보존된다 / the order spans hidden columns so their relative slots survive
  const orderedAll = applyColumnOrder(data.columns, order);
  const columns = orderedAll.filter((column) => !hiddenSet.has(column));
  const rows = sortRows(data.rows, sort);
  const uniqueItems = uniqueColumn ? countUniqueValues(data.rows, uniqueColumn) : [];

  const getFont = (el: Element | null): string => {
    if (!el) return "12px sans-serif";
    const style = getComputedStyle(el);
    return `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  };

  /** 컬럼 내용을 한 줄로 폈을 때의 최대 폭(px, 패딩 포함) — 헤더 이름도 후보에 넣는다 */
  const measureColumnWidth = (column: string): number => {
    const ctx = measureRef.current
      ?? (measureRef.current = document.createElement("canvas").getContext("2d"));
    const table = tableRef.current;
    if (!ctx || !table) return DEFAULT_COL_WIDTH;
    const index = columns.indexOf(column);
    const headCell = table.rows[0]?.cells[index] ?? null;
    const bodyCell = table.rows[1]?.cells[index] ?? null;
    ctx.font = getFont(headCell);
    let widest = ctx.measureText(column).width + SORT_ICON_SPACE;
    ctx.font = getFont(bodyCell ?? headCell);
    for (const row of rows) {
      const width = ctx.measureText(String(row[column] ?? "")).width;
      if (width > widest) widest = width;
    }
    return Math.ceil(widest) + CELL_PADDING_X;
  };

  /** 더블클릭 = 내용 맞춤. 말줄임이면 전문이 한 줄에 들어가는 폭, 줄바꿈이면 그 폭을
   * 3등분해 대략 3줄에서 끊는다. 이미 맞춤 폭이면 기본 상한으로 되돌려 왕복이 된다.
   * / double-click fits to content: one full line when ellipsizing, a third of it when
   *   wrapping (~3 lines); a second double-click restores the default cap. */
  const fitColumnWidth = (column: string) => {
    const content = measureColumnWidth(column);
    const target = Math.min(
      Math.max(
        wrapCells
          ? Math.min(
              content,
              Math.max(Math.round((content / WRAP_TARGET_LINES) * WRAP_SLACK), WRAP_MIN_WIDTH),
            )
          : content,
        MIN_COL_WIDTH,
      ),
      MAX_COL_WIDTH,
    );
    setWidths((cur) => {
      const current = cur[column];
      if (current !== undefined && Math.abs(current - target) <= 1) {
        const next = { ...cur };
        delete next[column];
        return next;
      }
      return { ...cur, [column]: target };
    });
  };

  const menuAction = (action: () => void) => {
    action();
    setMenu(null);
  };

  /** 고유값 → 필터 조건 추가. 조회는 사용자가 [조회]로 직접 낸다(추가마다 재질의 금지)
   * / stage the condition only; the user runs [Query] themselves */
  const stageValueFilter = (op: "eq" | "neq") => {
    if (!uniqueColumn || !valueMenu) return;
    // 모달의 값은 문자열이라 빈 문자열이 곧 NULL 표기(∅) — 셀 더블클릭과 같은 관례로 넘긴다
    onQuickFilter?.(uniqueColumn, valueMenu.value === "" ? null : valueMenu.value, op);
    setValueMenu(null);
    showToast(t("preview.filterStaged"));
  };

  const copyValue = () => {
    if (!valueMenu) return;
    const { value } = valueMenu;
    setValueMenu(null);
    // HTTP(비보안 컨텍스트)에서도 동작 — 공용 헬퍼가 execCommand로 폴백한다
    copyTextToClipboard(value).then((ok) =>
      showToast(t(ok ? "preview.copied" : "preview.copyFailed")));
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
                className={"relative cursor-pointer whitespace-nowrap px-3 py-1.5 font-mono font-medium"
                  + (column === highlightColumn ? " preview-col-pin" : "")}
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
                // 좌클릭도 같은 메뉴 — 우클릭만 열리는 건 발견되지 않는다(사용자 리포트).
                // 드래그로 순서를 바꾼 뒤에는 click이 발생하지 않아 순서 변경과 겹치지 않는다
                // / left-click opens the same menu; a real drag never fires click
                onClick={(e) => setMenu({ column, x: e.clientX, y: e.clientY })}
                data-testid={`PreviewTable-header-${column}`}
              >
                <span className="inline-block align-middle"
                      style={{ maxWidth: Math.max(
                                 (widths[column] ?? DEFAULT_COL_WIDTH) - CELL_PADDING_X,
                                 MIN_COL_WIDTH),
                               overflow: "hidden", textOverflow: "ellipsis",
                               whiteSpace: "nowrap" }}>
                  {column}
                </span>
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
                  title={t("preview.fitColumnTitle")}
                  onPointerDown={(e) => startColumnResize(e, column)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    fitColumnWidth(column);
                  }}
                  onClick={(e) => e.stopPropagation()}
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
                <td key={column}
                    className={"px-3 py-1 align-top"
                      + (column === highlightColumn ? " preview-col-pin" : "")}
                    style={cellStyle(column)}
                    title={String(row[column] ?? "")}
                    onDoubleClick={() => onQuickFilter?.(column, row[column])}>
                  <span className="block" style={contentStyle(column)}>
                    {String(row[column] ?? "")}
                  </span>
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
              {onQuickFilter && ` · ${t("preview.uniqueRowHint")}`}
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
                    <tr
                      key={value}
                      className="pressable border-t"
                      style={{ borderColor: "var(--hairline)" }}
                      onClick={(e) => setValueMenu({ value, x: e.clientX, y: e.clientY })}
                      data-testid={`PreviewTable-uniqueRow-${value}`}
                    >
                      <td className="max-w-64 truncate py-1 font-mono">{value || "∅"}</td>
                      <td className="text-right tabular-nums" style={{ color: "var(--stat-ink)" }}>
                        {count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 값 메뉴 — 모달 안에 두어야 바깥 mousedown 닫기에 모달까지 닫히지 않는다 */}
            {valueMenu && (
              <div ref={valueMenuRef} className="erd-menu !fixed"
                   style={{ left: valueMenu.x, top: valueMenu.y }}
                   data-testid="PreviewTable-uniqueValueMenu">
                <div className="erd-menu__label max-w-56 truncate font-mono">
                  {valueMenu.value || "∅"}
                </div>
                <button className="pressable erd-menu__item" onClick={copyValue}
                        data-testid="PreviewTable-copyValueItem">
                  {t("preview.copyValue")}
                </button>
                {onQuickFilter && (
                  <>
                    <button className="pressable erd-menu__item"
                            onClick={() => stageValueFilter("eq")}
                            data-testid="PreviewTable-onlyValueItem">
                      {t("preview.onlyThisValue")}
                    </button>
                    <button className="pressable erd-menu__item"
                            onClick={() => stageValueFilter("neq")}
                            data-testid="PreviewTable-excludeValueItem">
                      {t("preview.excludeThisValue")}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 토스트 — 모달(z-50) 위에 뜬다 / above the modal layer */}
      {toast && (
        <div
          className="fixed bottom-8 left-1/2 z-[60] -translate-x-1/2 rounded-lg border px-4 py-2 text-sm"
          style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-elevated)",
                   color: "var(--ink)" }}
          data-testid="PreviewTable-toast"
        >
          {toast.text}
        </div>
      )}
    </>
  );
}
