"use client";

/** 공용 미리보기 테이블 — 헤더 우클릭(정렬·숨김·고유값 모달) / shared preview grid. */

import { useEffect, useRef, useState } from "react";

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

export function PreviewTable({ data, hidden, sort, onToggleHidden, onSort }: Props) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<HeaderMenu | null>(null);
  const [uniqueColumn, setUniqueColumn] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

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
                className="cursor-context-menu whitespace-nowrap px-3 py-1.5 font-mono font-medium"
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ column, x: e.clientX, y: e.clientY });
                }}
                data-testid={`PreviewTable-header-${column}`}
              >
                {column}
                {sort?.column === column && (
                  <span style={{ color: "var(--stat-ink)" }}>
                    {" "}{sort.dir === "asc" ? "▲" : "▼"}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-t transition-colors duration-150 ease-in-out hover:bg-[var(--soft-stone)]"
                style={{ borderColor: "var(--hairline)" }}>
              {columns.map((column) => (
                <td key={column} className="whitespace-nowrap px-3 py-1">
                  {String(row[column] ?? "")}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="px-3 py-4" style={{ color: "var(--muted)" }}
                  colSpan={Math.max(columns.length, 1)} data-testid="PreviewTable-emptyState">
                {t("preview.empty")}
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
            {t("preview.sortAsc")} ▲
          </button>
          <button className="pressable erd-menu__item"
                  onClick={() => menuAction(() => onSort({ column: menu.column, dir: "desc" }))}
                  data-testid="PreviewTable-sortDescItem">
            {t("preview.sortDesc")} ▼
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
             onClick={() => setUniqueColumn(null)}>
          <div
            className="flex max-h-[70vh] w-96 flex-col rounded-xl border p-4"
            style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-card)" }}
            onClick={(e) => e.stopPropagation()}
            data-testid="PreviewTable-uniqueModal"
          >
            <div className="mb-1 flex items-center gap-2">
              <span className="font-mono text-sm font-semibold" style={{ color: "var(--ink)" }}>
                {uniqueColumn}
              </span>
              <span className="badge badge--muted">{uniqueItems.length}</span>
              <button className="icon-button ml-auto" onClick={() => setUniqueColumn(null)}
                      data-testid="PreviewTable-uniqueCloseButton">
                ✕
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
