"use client";

/** 하단 미리보기 — 다중 탭·분할·컬럼 제어·행수·CSV / tabbed, splittable preview area. */

import { useEffect, useRef, useState } from "react";

import { useI18n } from "@/components/i18n";
import { CaretDownIcon, CloseIcon } from "@/components/icons";
import { InfoTip } from "@/components/InfoTip";
import { PreviewSqlButton } from "@/components/PreviewSqlButton";
import { PreviewTable } from "@/components/PreviewTable";
import type { TablePreview } from "@/lib/api";
import {
  applyColumnOrder,
  buildCsv,
  countUniqueValues,
  isNullOp,
  sortRows,
  type PreviewFilterCond,
  type PreviewFilterOp,
  type SortSpec,
} from "@/lib/preview-utils";

// 행수 선택지 — 서버 상한 500과 일치 / matches the server-side hard cap
const LIMIT_OPTIONS = [20, 50, 100, 200, 500];
// 조건 수 상한 — 서버 MAX_PREVIEW_FILTERS와 일치 / matches the server-side cap
const MAX_FILTERS = 5;
// 칩 표기 기호 — 감사 로그와 같은 언어 중립 표기 / language-neutral, mirrors the audit log
const OP_SYMBOLS: Record<PreviewFilterOp, string> = {
  contains: "~", eq: "=", not_contains: "!~", neq: "≠",
  is_null: "IS NULL", not_null: "IS NOT NULL",
};
const FILTER_OPS: PreviewFilterOp[] = [
  "contains", "eq", "not_contains", "neq", "is_null", "not_null",
];
// 값 자동완성 후보 상한 — 로드된 행 기준이라 많아야 의미 없다
const VALUE_SUGGESTION_LIMIT = 50;

export interface PreviewTabState {
  id: number;
  qname: string;
  data: TablePreview | null;
  loading: boolean;
  hidden: string[];
  sort: SortSpec | null;
  /** 헤더 드래그로 정한 컬럼 순서 — 빈 배열이면 원본 순서 / drag-defined column order */
  order: string[];
}

export interface RefetchOptions {
  /** AND 결합 조건 목록 — 생략·빈 배열은 무필터 / AND-combined, empty = unfiltered */
  filters?: PreviewFilterCond[];
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
  onPatch: (id: number, patch: Partial<Pick<PreviewTabState, "hidden" | "sort" | "order">>) => void;
}

function PreviewPane({ tab, onRefetch, onPatch }: {
  tab: PreviewTabState;
  onRefetch: Props["onRefetch"];
  onPatch: Props["onPatch"];
}) {
  const { t } = useI18n();
  // 드래프트 = 아직 추가하지 않은 입력 — 적용된 조건은 서버 echo(data.filters)가 원본
  // / draft inputs only; applied conditions live in the server-echoed data.filters
  const [draftColumn, setDraftColumn] = useState("");
  const [draftOp, setDraftOp] = useState<PreviewFilterOp>("contains");
  const [draftValue, setDraftValue] = useState("");
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsRef = useRef<HTMLDivElement | null>(null);

  // 다른 테이블 탭으로 바뀌면 드래프트 초기화 / reset drafts when the tab changes
  useEffect(() => {
    setDraftColumn("");
    setDraftOp("contains");
    setDraftValue("");
  }, [tab.id]);

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
  const applied = data?.filters ?? [];

  const isDuplicate = (cond: PreviewFilterCond) => applied.some(
    (c) => c.column === cond.column && c.op === cond.op && c.value === cond.value);
  // 추가 = 즉시 재조회 — 칩은 항상 적용된 조건만 보여 화면과 데이터가 어긋나지 않는다
  // / adding requeries immediately so chips never show unapplied state
  const appendFilter = (cond: PreviewFilterCond) => {
    if (tab.loading || applied.length >= MAX_FILTERS || isDuplicate(cond)) return;
    onRefetch(tab.id, { filters: [...applied, cond], limit });
  };
  const draftCond: PreviewFilterCond = {
    column: draftColumn, op: draftOp,
    value: isNullOp(draftOp) ? null : draftValue.trim(),
  };
  const canAdd = draftColumn !== "" && !tab.loading && applied.length < MAX_FILTERS
    && (isNullOp(draftOp) || draftValue.trim() !== "") && !isDuplicate(draftCond);
  const addDraftFilter = () => {
    if (!canAdd) return;
    appendFilter(draftCond);
    setDraftValue("");
  };
  // 값 자동완성 — 로드된 행의 고유값 상위 N개 / suggestions from loaded rows
  const valueSuggestions = data && draftColumn !== "" && !isNullOp(draftOp)
    ? countUniqueValues(data.rows, draftColumn).slice(0, VALUE_SUGGESTION_LIMIT)
    : [];

  const downloadCsv = () => {
    if (!data) return;
    // 화면과 같은 순서로 내려받는다 — 드래그 순서가 CSV에도 반영 / CSV mirrors the drag order
    const visible = applyColumnOrder(data.columns, tab.order)
      .filter((column) => !tab.hidden.includes(column));
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
          value={draftColumn}
          onChange={(e) => setDraftColumn(e.target.value)}
          data-testid="PreviewSection-filterColumnSelect"
        >
          <option value="">{t("preview.selectColumn")}</option>
          {(data?.columns ?? []).map((column) => (
            <option key={column} value={column}>{column}</option>
          ))}
        </select>
        {/* 연산자 — 포함/정확과 제외형, NULL 검사. 소스 쿼리 WHERE로 내려간다 */}
        <select
          className="h-10 rounded-lg border px-2 text-sm"
          style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-elevated)" }}
          title={t("preview.matchModeTitle")}
          value={draftOp}
          onChange={(e) => setDraftOp(e.target.value as PreviewFilterOp)}
          data-testid="PreviewSection-filterOpSelect"
        >
          {FILTER_OPS.map((op) => (
            <option key={op} value={op}>{t(`preview.op.${op}`)}</option>
          ))}
        </select>
        <input
          className="h-10 w-48 rounded-lg border px-3 text-sm outline-none transition-colors duration-200 ease-in-out focus:border-[var(--focus-blue)] disabled:opacity-45"
          style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-elevated)" }}
          placeholder={t("preview.valuePlaceholder")}
          value={draftValue}
          disabled={isNullOp(draftOp)}
          list={`PreviewSection-valueOptions-${tab.id}`}
          onChange={(e) => setDraftValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addDraftFilter();
          }}
          data-testid="PreviewSection-filterValueInput"
        />
        <datalist id={`PreviewSection-valueOptions-${tab.id}`}
                  data-testid="PreviewSection-valueDatalist">
          {valueSuggestions.map(({ value }) => (
            <option key={value} value={value} />
          ))}
        </datalist>
        <button
          className="btn-primary"
          disabled={!canAdd}
          title={applied.length >= MAX_FILTERS ? t("preview.maxFilters") : undefined}
          onClick={addDraftFilter}
          data-testid="PreviewSection-addFilterButton"
        >
          {tab.loading ? t("detail.loading") : t("preview.addFilter")}
        </button>
        {applied.length > 0 && (
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
          onChange={(e) => onRefetch(tab.id, { filters: applied, limit: Number(e.target.value) })}
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
                    className="checkbox"
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
            state={{ object: data.object, limit: data.limit, filters: data.filters }}
            // 드래그 순서까지 화면과 동일하게 — SQL 보기는 화면의 재현이다
            visibleColumns={applyColumnOrder(data.columns, tab.order)
              .filter((column) => !tab.hidden.includes(column))}
            allColumns={applyColumnOrder(data.columns, tab.order)}
            sort={tab.sort}
            onApplyColumns={(visible) => {
              const keep = new Set(visible);
              onPatch(tab.id, {
                hidden: data.columns.filter((column) => !keep.has(column)),
                order: visible,
              });
            }}
            buttonClassName="icon-button h-10"
          />
        )}
        <button className="icon-button h-10" disabled={!data} onClick={downloadCsv}
                data-testid="PreviewSection-csvButton">
          {t("preview.csv")}
        </button>
      </div>

      {/* 적용된 조건 칩 — ×로 개별 제거, 제거 즉시 재조회 / applied-condition chips */}
      {applied.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5"
             data-testid="PreviewSection-filterChips">
          {applied.map((cond, index) => (
            <span key={`${cond.column}-${cond.op}-${cond.value}`}
                  className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px]"
                  style={{ borderColor: "var(--hairline-strong)",
                           background: "var(--surface-elevated)", color: "var(--body-text)" }}
                  title={t(`preview.op.${cond.op}`)}
                  data-testid={`PreviewSection-filterChip-${index}`}>
              {cond.column} {OP_SYMBOLS[cond.op]}
              {!isNullOp(cond.op) && ` "${cond.value}"`}
              <button
                className="pressable rounded-full leading-none"
                style={{ color: "var(--muted)" }}
                title={t("preview.removeFilter")}
                onClick={() => onRefetch(tab.id, {
                  filters: applied.filter((_, i) => i !== index), limit,
                })}
                data-testid={`PreviewSection-filterChipRemove-${index}`}
              >
                <CloseIcon size={9} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="mb-2 flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
        {data && <span>{data.rows.length}{t("preview.rowsSuffix")}</span>}
        {data && data.masked_columns.length > 0 && (
          <span className="badge badge--muted">
            {t("preview.masked")} {data.masked_columns.length}{t("preview.maskedSuffix")}
          </span>
        )}
        <span>{t("preview.requeryHint")}</span>
        <span>{t("preview.quickFilterHint")}</span>
      </div>

      <div className="scroll-area rounded-lg border"
           style={{ borderColor: "var(--hairline)", maxHeight: "26rem", overflow: "auto" }}>
        {data ? (
          <PreviewTable
            data={data}
            hidden={tab.hidden}
            sort={tab.sort}
            order={tab.order}
            onToggleHidden={(column) => onPatch(tab.id, {
              hidden: tab.hidden.includes(column)
                ? tab.hidden.filter((c) => c !== column)
                : [...tab.hidden, column],
            })}
            onSort={(sort) => onPatch(tab.id, { sort })}
            onReorder={(order) => onPatch(tab.id, { order })}
            // 셀 더블클릭 = 그 값으로 eq 조건 (null 셀은 IS NULL) / cell quick-filter
            onQuickFilter={(column, value) => appendFilter(
              value === null || value === undefined
                ? { column, op: "is_null", value: null }
                : { column, op: "eq", value: String(value) },
            )}
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
