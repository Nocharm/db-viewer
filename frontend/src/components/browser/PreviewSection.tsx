"use client";

/** 하단 미리보기 섹션 — 컬럼·값 필터 재검색 포함 / bottom preview with column-value refetch. */

import { useEffect, useState } from "react";

import { useI18n } from "@/components/i18n";
import type { TablePreview } from "@/lib/api";

interface Props {
  preview: TablePreview;
  loading: boolean;
  onSearch: (column: string, value: string) => void;
  onClear: () => void;
}

export function PreviewSection({ preview, loading, onSearch, onClear }: Props) {
  const { t } = useI18n();
  const [filterColumn, setFilterColumn] = useState(preview.filter?.column ?? "");
  const [filterValue, setFilterValue] = useState(preview.filter?.value ?? "");

  // 다른 테이블 미리보기로 전환되면 필터 입력 초기화 / reset inputs on table switch
  useEffect(() => {
    setFilterColumn(preview.filter?.column ?? "");
    setFilterValue(preview.filter?.value ?? "");
  }, [preview.object, preview.filter]);

  const canSearch = filterColumn !== "" && filterValue.trim() !== "" && !loading;

  return (
    <section
      className="card px-6 py-5"
      data-testid="PreviewSection-root"
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h3 className="text-base font-semibold tracking-tight" style={{ color: "var(--ink)" }}>
          {t("preview.title")} — <span className="font-mono">{preview.object}</span>
        </h3>
        <span className="badge badge--muted">TOP {preview.limit}</span>
        {preview.masked_columns.length > 0 && (
          <span className="badge badge--muted">
            {t("preview.masked")} {preview.masked_columns.length}{t("preview.maskedSuffix")}
          </span>
        )}
        <span className="text-sm" style={{ color: "var(--muted)" }}>
          {preview.rows.length}{t("preview.rowsSuffix")}
          {preview.filter && ` — ${preview.filter.column} ~ "${preview.filter.value}"`}
        </span>
      </div>

      {/* 필터 조건 재검색 / column-value refetch bar */}
      <div className="mb-4 flex flex-wrap items-center gap-2"
           data-testid="PreviewSection-filterBar">
        <select
          className="h-10 rounded-lg border px-3 text-sm"
          style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-elevated)" }}
          value={filterColumn}
          onChange={(e) => setFilterColumn(e.target.value)}
          data-testid="PreviewSection-filterColumnSelect"
        >
          <option value="">{t("preview.selectColumn")}</option>
          {preview.columns.map((column) => (
            <option key={column} value={column}>{column}</option>
          ))}
        </select>
        <input
          className="h-10 w-56 rounded-lg border px-3 text-sm outline-none transition-colors duration-200 ease-in-out focus:border-[var(--focus-blue)]"
          style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-elevated)" }}
          placeholder={t("preview.valuePlaceholder")}
          value={filterValue}
          onChange={(e) => setFilterValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSearch) onSearch(filterColumn, filterValue.trim());
          }}
          data-testid="PreviewSection-filterValueInput"
        />
        <button
          className="btn-primary"
          disabled={!canSearch}
          onClick={() => onSearch(filterColumn, filterValue.trim())}
          data-testid="PreviewSection-searchButton"
        >
          {loading ? t("detail.loading") : t("preview.requery")}
        </button>
        <span className="text-xs" style={{ color: "var(--muted)" }}>
          {t("preview.requeryHint")}
        </span>
        {preview.filter && (
          <button className="icon-button" onClick={onClear}
                  data-testid="PreviewSection-clearButton">
            {t("preview.clear")}
          </button>
        )}
      </div>

      <div className="scroll-area rounded-lg border"
           style={{ borderColor: "var(--hairline)", maxHeight: "26rem" }}>
        <table className="w-full text-xs">
          <thead>
            <tr className="sticky top-0 border-b text-left"
                style={{ borderColor: "var(--hairline)", background: "var(--canvas)" }}>
              {preview.columns.map((column) => (
                <th key={column} className="whitespace-nowrap px-3 py-2 font-mono font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, index) => (
              <tr key={index} className="border-b transition-colors duration-150 ease-in-out hover:bg-[var(--soft-stone)]"
                  style={{ borderColor: "var(--hairline)" }}>
                {preview.columns.map((column) => (
                  <td key={column} className="whitespace-nowrap px-3 py-1.5">
                    {String(row[column] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
            {preview.rows.length === 0 && (
              <tr>
                <td className="px-3 py-4" style={{ color: "var(--muted)" }}
                    colSpan={preview.columns.length} data-testid="PreviewSection-emptyState">
                  {t("preview.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
