"use client";

/** 공용 미리보기 테이블 — 헤더 우클릭(정렬·숨김·고유값 모달) / shared preview grid. */

import { useEffect, useRef, useState } from "react";

import { ArrowDownIcon, ArrowUpIcon, CloseIcon } from "@/components/icons";
import { useI18n } from "@/components/i18n";
import type { TablePreview } from "@/lib/api";
import { countUniqueValues, sortRows, type SortSpec } from "@/lib/preview-utils";

interface Props {
  data: TablePreview;
  hidden: string[];
  sort: SortSpec | null;
  onToggleHidden: (column: string) => void;
  onSort: (sort: SortSpec | null) => void;
}

interface HeaderMenu {
  column: string;
  x: number;
  y: number;
}

// 컬럼 폭 드래그 한계(px) / drag clamp for column widths
const MIN_COL_WIDTH = 48;
const MAX_COL_WIDTH = 800;

export function PreviewTable({ data, hidden, sort, onToggleHidden, onSort }: Props) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<HeaderMenu | null>(null);
  const [uniqueColumn, setUniqueColumn] = useState<string | null>(null);
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
  const columns = data.columns.filter((column) => !hiddenSet.has(column));
  const rows = sortRows(data.rows, sort);
  const uniqueItems = uniqueColumn ? countUniqueValues(data.rows, uniqueColumn) : [];

  const menuAction = (action: () => void) => {
    action();
    setMenu(null);
  };

  return (
    <>
      <table className="w-full text-xs">
        <thead>
          <tr className="sticky top-0 text-left" style={{ background: "var(--surface-card)" }}>
            {columns.map((column) => (
              <th
                key={column}
                className="relative cursor-context-menu whitespace-nowrap px-3 py-1.5 font-mono font-medium"
                style={cellStyle(column)}
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
                    title={String(row[column] ?? "")}>
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
                {data.filter || data.source !== "live"
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
