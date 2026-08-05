"use client";

/** 하단 미리보기 — 다중 탭·분할·컬럼 제어·행수·CSV / tabbed, splittable preview area. */

import { useEffect, useRef, useState } from "react";

import { useI18n } from "@/components/i18n";
import { CaretDownIcon, CloseIcon } from "@/components/icons";
import { InfoTip } from "@/components/InfoTip";
import { PreviewSqlButton } from "@/components/PreviewSqlButton";
import { PreviewTable } from "@/components/PreviewTable";
import type { TablePreview } from "@/lib/api";
import { buildCsv, sortRows, type SortSpec } from "@/lib/preview-utils";

// 행수 선택지 — 서버 상한 500과 일치 / matches the server-side hard cap
const LIMIT_OPTIONS = [20, 50, 100, 200, 500];

export interface PreviewTabState {
  id: number;
  qname: string;
  data: TablePreview | null;
  loading: boolean;
  hidden: string[];
  sort: SortSpec | null;
}

export interface RefetchOptions {
  filterColumn?: string;
  filterValue?: string;
  limit?: number;
}

interface Props {
  tabs: PreviewTabState[];
  activeId: number | null;
  splitId: number | null;
  onActivate: (id: number) => void;
  onClose: (id: number) => void;
  onSplitPick: (id: number | null) => void;
  onRefetch: (id: number, opts: RefetchOptions) => void;
  onPatch: (id: number, patch: Partial<Pick<PreviewTabState, "hidden" | "sort">>) => void;
}

function PreviewPane({ tab, onRefetch, onPatch }: {
  tab: PreviewTabState;
  onRefetch: Props["onRefetch"];
  onPatch: Props["onPatch"];
}) {
  const { t } = useI18n();
  const [filterColumn, setFilterColumn] = useState(tab.data?.filter?.column ?? "");
  const [filterValue, setFilterValue] = useState(tab.data?.filter?.value ?? "");
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsRef = useRef<HTMLDivElement | null>(null);

  // 다른 테이블 데이터로 갱신되면 필터 입력 동기화 / sync inputs on data swap
  useEffect(() => {
    setFilterColumn(tab.data?.filter?.column ?? "");
    setFilterValue(tab.data?.filter?.value ?? "");
  }, [tab.id, tab.data?.filter]);

  useEffect(() => {
    if (!columnsOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (!columnsRef.current?.contains(e.target as Node)) setColumnsOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [columnsOpen]);

  const data = tab.data;
  const limit = data?.limit ?? 20;
  const canSearch = filterColumn !== "" && filterValue.trim() !== "" && !tab.loading;
  const currentFilter: RefetchOptions = data?.filter
    ? { filterColumn: data.filter.column, filterValue: data.filter.value ?? undefined }
    : {};

  const downloadCsv = () => {
    if (!data) return;
    const visible = data.columns.filter((column) => !tab.hidden.includes(column));
    const blob = new Blob([buildCsv(visible, sortRows(data.rows, tab.sort))],
      { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${tab.qname.replace(".", "_")}_preview.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-w-0 flex-1" data-testid={`PreviewSection-pane-${tab.id}`}>
      <div className="mb-3 flex flex-wrap items-center gap-2"
           data-testid="PreviewSection-filterBar">
        <select
          className="h-10 rounded-lg border px-3 text-sm"
          style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-elevated)" }}
          value={filterColumn}
          onChange={(e) => setFilterColumn(e.target.value)}
          data-testid="PreviewSection-filterColumnSelect"
        >
          <option value="">{t("preview.selectColumn")}</option>
          {(data?.columns ?? []).map((column) => (
            <option key={column} value={column}>{column}</option>
          ))}
        </select>
        <input
          className="h-10 w-48 rounded-lg border px-3 text-sm outline-none transition-colors duration-200 ease-in-out focus:border-[var(--focus-blue)]"
          style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-elevated)" }}
          placeholder={t("preview.valuePlaceholder")}
          value={filterValue}
          onChange={(e) => setFilterValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSearch) {
              onRefetch(tab.id, { filterColumn, filterValue: filterValue.trim(), limit });
            }
          }}
          data-testid="PreviewSection-filterValueInput"
        />
        <button
          className="btn-primary"
          disabled={!canSearch}
          onClick={() => onRefetch(tab.id, { filterColumn, filterValue: filterValue.trim(), limit })}
          data-testid="PreviewSection-searchButton"
        >
          {tab.loading ? t("detail.loading") : t("preview.requery")}
        </button>
        {data?.filter && (
          <button className="icon-button"
                  onClick={() => onRefetch(tab.id, { limit })}
                  data-testid="PreviewSection-clearButton">
            {t("preview.clear")}
          </button>
        )}

        <select
          className="ml-auto h-10 rounded-lg border px-2 text-sm"
          style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-elevated)" }}
          title={t("preview.limitTitle")}
          value={limit}
          onChange={(e) => onRefetch(tab.id, { ...currentFilter, limit: Number(e.target.value) })}
          data-testid="PreviewSection-limitSelect"
        >
          {LIMIT_OPTIONS.map((option) => (
            <option key={option} value={option}>TOP {option}</option>
          ))}
        </select>

        {/* 컬럼 표시/숨김 드롭다운 / column visibility dropdown */}
        <div ref={columnsRef} className="relative">
          <button className="icon-button h-10" onClick={() => setColumnsOpen((cur) => !cur)}
                  data-testid="PreviewSection-columnsButton">
            {t("preview.columnsMenu")}{tab.hidden.length > 0 ? ` (-${tab.hidden.length})` : ""}{" "}
            <CaretDownIcon size={11} className="inline-block align-middle" />
          </button>
          {columnsOpen && (
            <div className="erd-menu right-0 top-full mt-1 max-h-72 w-56 overflow-y-auto"
                 data-testid="PreviewSection-columnsMenu">
              <button className="pressable erd-menu__item font-medium"
                      onClick={() => onPatch(tab.id, { hidden: [] })}
                      data-testid="PreviewSection-showAllColumns">
                {t("preview.showAllColumns")}
              </button>
              {(data?.columns ?? []).map((column) => (
                <label key={column}
                       className="erd-menu__item flex cursor-pointer items-center gap-2 font-mono text-xs">
                  <input
                    type="checkbox"
                    checked={!tab.hidden.includes(column)}
                    onChange={() => onPatch(tab.id, {
                      hidden: tab.hidden.includes(column)
                        ? tab.hidden.filter((c) => c !== column)
                        : [...tab.hidden, column],
                    })}
                    data-testid={`PreviewSection-columnCheck-${column}`}
                  />
                  {column}
                </label>
              ))}
            </div>
          )}
        </div>

        {data && (
          <PreviewSqlButton
            state={{ object: data.object, limit: data.limit, filter: data.filter }}
            visibleColumns={data.columns.filter((column) => !tab.hidden.includes(column))}
            sort={tab.sort}
            buttonClassName="icon-button h-10"
          />
        )}
        <button className="icon-button h-10" disabled={!data} onClick={downloadCsv}
                data-testid="PreviewSection-csvButton">
          {t("preview.csv")}
        </button>
      </div>

      <div className="mb-2 flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
        {data && <span>{data.rows.length}{t("preview.rowsSuffix")}</span>}
        {data && data.masked_columns.length > 0 && (
          <span className="badge badge--muted">
            {t("preview.masked")} {data.masked_columns.length}{t("preview.maskedSuffix")}
          </span>
        )}
        {data?.filter && (
          <span>— {data.filter.column} ~ &quot;{data.filter.value}&quot;</span>
        )}
        <span>{t("preview.requeryHint")}</span>
      </div>

      <div className="scroll-area rounded-lg border"
           style={{ borderColor: "var(--hairline)", maxHeight: "26rem", overflow: "auto" }}>
        {data ? (
          <PreviewTable
            data={data}
            hidden={tab.hidden}
            sort={tab.sort}
            onToggleHidden={(column) => onPatch(tab.id, {
              hidden: tab.hidden.includes(column)
                ? tab.hidden.filter((c) => c !== column)
                : [...tab.hidden, column],
            })}
            onSort={(sort) => onPatch(tab.id, { sort })}
          />
        ) : (
          <div className="p-4">
            <div className="skeleton h-24 w-full" />
          </div>
        )}
      </div>
    </div>
  );
}

export function PreviewSection({
  tabs, activeId, splitId, onActivate, onClose, onSplitPick, onRefetch, onPatch,
}: Props) {
  const { t } = useI18n();
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? null;
  const split = splitId !== null ? tabs.find((tab) => tab.id === splitId) ?? null : null;

  if (tabs.length === 0) return null;

  return (
    <section className="card px-6 py-5" data-testid="PreviewSection-root">
      {/* 탭 바 — 같은 테이블은 탭 활성화로만 (중복 열기 차단은 page에서) */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5"
           data-testid="PreviewSection-tabBar">
        <h3 className="flex items-center gap-1.5 mr-2 text-base font-semibold tracking-tight"
            style={{ color: "var(--ink)" }}>
          {t("preview.title")}
          <InfoTip text={t("tip.preview")} />
        </h3>
        {tabs.map((tab) => (
          <span key={tab.id}
                className={`key-chip flex items-center gap-1 ${tab.id === active?.id || tab.id === splitId ? "key-chip--selected" : ""}`}>
            <button className="pressable font-mono"
                    onClick={() => onActivate(tab.id)}
                    data-testid={`PreviewSection-tab-${tab.id}`}>
              {tab.qname}
            </button>
            <button className="pressable px-0.5" onClick={() => onClose(tab.id)}
                    title={t("erd.cancel")}
                    data-testid={`PreviewSection-tabClose-${tab.id}`}>
              <CloseIcon />
            </button>
          </span>
        ))}
        {tabs.length >= 2 && (
          <button
            className="icon-button ml-auto"
            onClick={() => {
              if (splitId !== null) {
                onSplitPick(null);
              } else {
                const other = tabs.find((tab) => tab.id !== active?.id);
                if (other) onSplitPick(other.id);
              }
            }}
            data-testid="PreviewSection-splitButton"
          >
            {splitId !== null ? t("preview.single") : t("preview.split")}
          </button>
        )}
      </div>

      <div className="flex gap-5">
        {active && <PreviewPane tab={active} onRefetch={onRefetch} onPatch={onPatch} />}
        {split && split.id !== active?.id && (
          <PreviewPane tab={split} onRefetch={onRefetch} onPatch={onPatch} />
        )}
      </div>
    </section>
  );
}
