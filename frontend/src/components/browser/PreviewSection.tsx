"use client";

/** 하단 미리보기 — 다중 탭·분할·컬럼 제어·행수·CSV / tabbed, splittable preview area. */

import { useEffect, useRef, useState } from "react";

import { useI18n } from "@/components/i18n";
import {
  ArrowUpIcon, CaretDownIcon, CloseIcon, ColumnsIcon, DownloadIcon, EllipsisTextIcon,
  FilterIcon, ResetIcon, SearchIcon, SplitIcon, WrapTextIcon,
} from "@/components/icons";
import { InfoTip } from "@/components/InfoTip";
import { PreviewSqlButton } from "@/components/PreviewSqlButton";
import { PreviewTable } from "@/components/PreviewTable";
import type { TablePreview } from "@/lib/api";
import {
  appendFilterCond,
  applyColumnOrder,
  buildCsv,
  condKey,
  countUniqueValues,
  hasUnappliedChanges,
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
  /** 계속 강조할 컬럼 — 조인 검증에서 "지금 검증 중인 컬럼" 표시용 (없으면 null) */
  highlight?: string | null;
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
  /** 우상단 ↑ 버튼 — 표를 휠로 거슬러 올라가지 않고 테이블 상세로 돌아간다 / jump back up */
  onJumpToTop: () => void;
}

function PreviewPane({ tab, wrapCells, onRefetch, onPatch }: {
  tab: PreviewTabState;
  /** 긴 값 표시 모드 — 탭바 토글이 두 페인에 함께 적용된다 / shared by both panes */
  wrapCells: boolean;
  onRefetch: Props["onRefetch"];
  onPatch: Props["onPatch"];
}) {
  const { t } = useI18n();
  // 드래프트 = 아직 추가하지 않은 입력, 스테이징 = 칩으로 쌓인 조건 — [조회]를 눌러야
  // 원본에 재질의된다 (추가마다 쿼리를 날리지 않는다 — 사용자 지시)
  // / drafts feed staged chips; only [Query] hits the source, not every add
  const [draftColumn, setDraftColumn] = useState("");
  const [draftOp, setDraftOp] = useState<PreviewFilterOp>("contains");
  const [draftValue, setDraftValue] = useState("");
  const [staged, setStaged] = useState<PreviewFilterCond[]>([]);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsRef = useRef<HTMLDivElement | null>(null);

  // 다른 테이블 탭으로 바뀌면 드래프트 초기화, 칩은 그 탭에 적용된 조건에서 다시 시작
  // / reset drafts on tab switch; chips re-sync from that tab's applied filters
  useEffect(() => {
    setDraftColumn("");
    setDraftOp("contains");
    setDraftValue("");
    setStaged(tab.data?.filters ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 탭 전환 시에만 동기화
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

  // 적용 여부 판별 — 아직 [조회] 전인 칩은 대시 테두리로 구분한다
  // / staged-only chips render dashed until [Query] applies them
  const appliedKeys = new Set(applied.map(condKey));
  const isDuplicate = (cond: PreviewFilterCond) =>
    staged.some((c) => condKey(c) === condKey(cond));
  const appendFilter = (cond: PreviewFilterCond) => {
    setStaged((cur) => appendFilterCond(cur, cond, MAX_FILTERS));
  };

  // 빈값 제외 — NOT NULL 칩을 걸고 즉시 재질의. 스테이징 모델과 일관되게, 대기 중이던
  // 다른 칩도 이때 함께 적용된다([조회]와 같은 의미). 상한에 막히면 [추가] 비활성과
  // 같은 정책으로 무동작 / stage NOT NULL and re-query now; pending chips apply too
  const excludeNulls = (column: string) => {
    const cond: PreviewFilterCond = { column, op: "not_null", value: null };
    const next = appendFilterCond(staged, cond, MAX_FILTERS);
    if (next === staged && !isDuplicate(cond)) return; // 상한 도달 — 추가 불가
    setStaged(next);
    onRefetch(tab.id, { filters: next, limit });
  };

  // 이 컬럼 필터 적용 — 드롭다운 선택 + 잠깐의 플래시로 시선 유도
  // / preselect in the filter bar, flash the select to draw the eye
  const [filterFlash, setFilterFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
  }, []);
  // 조건이 스테이징과 적용본이 같으면 [조회]는 눌러도 같은 질의 — 비활성으로 막는다
  const isDirty = hasUnappliedChanges(staged, applied);
  // 드래프트 작성 중이면 [조회] 자리가 [필터 추가]+[초기화]로 갈라진다
  const isDrafting = draftColumn !== "" || draftValue.trim() !== "";
  const resetDraft = () => {
    setDraftColumn("");
    setDraftOp("contains");
    setDraftValue("");
  };

  const pickFilterColumn = (column: string) => {
    setDraftColumn(column);
    setFilterFlash(true);
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    // 1.5s = CSS 애니메이션 길이와 일치 / matches the keyframes duration
    flashTimer.current = setTimeout(() => setFilterFlash(false), 1500);
  };
  const draftCond: PreviewFilterCond = {
    column: draftColumn, op: draftOp,
    value: isNullOp(draftOp) ? null : draftValue.trim(),
  };
  const canAdd = draftColumn !== "" && staged.length < MAX_FILTERS
    && (isNullOp(draftOp) || draftValue.trim() !== "") && !isDuplicate(draftCond);
  const addDraftFilter = () => {
    if (!canAdd) return;
    appendFilter(draftCond);
    resetDraft(); // 칩으로 넘어갔으니 드래프트를 비워 [조회] 자리로 복귀
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
          className={`h-10 rounded-lg border px-3 text-sm${filterFlash ? " filter-flash" : ""}`}
          style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-elevated)" }}
          value={draftColumn}
          onChange={(e) => {
            setDraftColumn(e.target.value);
            setDraftValue(""); // 컬럼을 바꾸면 이전 컬럼의 값은 무의미 — 자동 초기화
          }}
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
        {/* 이 자리는 상태에 따라 갈라진다 — 드래프트 작성 중엔 [추가]+[초기화],
            평시엔 [조회](조건 변경이 없으면 비활성) / the slot splits while drafting */}
        {isDrafting ? (
          <>
            <button
              className="btn-secondary"
              disabled={!canAdd}
              title={staged.length >= MAX_FILTERS ? t("preview.maxFilters") : undefined}
              onClick={addDraftFilter}
              data-testid="PreviewSection-addFilterButton"
            >
              <FilterIcon size={11} className="mr-1 inline-block align-middle" />
              {t("preview.addFilter")}
            </button>
            <button
              className="icon-button h-10"
              title={t("preview.resetDraft")}
              onClick={resetDraft}
              data-testid="PreviewSection-draftResetButton"
            >
              <ResetIcon size={12} />
            </button>
          </>
        ) : (
          <button
            className="btn-primary !py-0 h-10 inline-flex items-center justify-center text-xs"
            style={{ minWidth: "8.5rem" }}
            disabled={tab.loading || !isDirty}
            title={isDirty ? undefined : t("preview.noChanges")}
            onClick={() => onRefetch(tab.id, { filters: staged, limit })}
            data-testid="PreviewSection-runQueryButton"
          >
            <SearchIcon size={11} className="mr-1 inline-block align-middle" />
            {tab.loading ? t("detail.loading") : t("preview.runQuery")}
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
            <ColumnsIcon size={11} className="mr-1 inline-block align-middle" />
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
          <DownloadIcon size={11} className="mr-1 inline-block align-middle" />
          {t("preview.csv")}
        </button>
      </div>

      {/* 조건 칩 + 조회/해제 — 칩 편집은 로컬, [조회]가 재질의. 미적용 칩은 대시 테두리
          / staged chips with query/clear; dashed border marks not-yet-applied chips */}
      {(staged.length > 0 || applied.length > 0) && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5"
             data-testid="PreviewSection-filterChips">
          {staged.map((cond, index) => (
            <span key={condKey(cond)}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px]${
                    appliedKeys.has(condKey(cond)) ? "" : " chip-pending"}`}
                  style={{ borderColor: "var(--hairline-strong)",
                           background: "var(--surface-elevated)", color: "var(--body-text)",
                           ...(appliedKeys.has(condKey(cond))
                             ? undefined : { borderStyle: "dashed" }) }}
                  title={t(`preview.op.${cond.op}`)}
                  data-testid={`PreviewSection-filterChip-${index}`}>
              {cond.column} {OP_SYMBOLS[cond.op]}
              {!isNullOp(cond.op) && ` "${cond.value}"`}
              <button
                className="pressable rounded-full leading-none"
                style={{ color: "var(--muted)" }}
                title={t("preview.removeFilter")}
                onClick={() => setStaged((cur) => cur.filter((_, i) => i !== index))}
                data-testid={`PreviewSection-filterChipRemove-${index}`}
              >
                <CloseIcon size={9} />
              </button>
            </span>
          ))}
          <button
            className="icon-button"
            onClick={() => {
              setStaged([]);
              onRefetch(tab.id, { limit });
            }}
            data-testid="PreviewSection-clearButton"
          >
            <CloseIcon size={10} className="mr-1 inline-block align-middle" />
            {t("preview.clear")}
          </button>

        </div>
      )}

      <div className="mb-2 flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
        {data && <span>{data.rows.length}{t("preview.rowsSuffix")}</span>}
        {data && data.masked_columns.length > 0 && (
          <span className="badge badge--muted">
            {t("preview.masked")} {data.masked_columns.length}{t("preview.maskedSuffix")}
          </span>
        )}
        <span data-testid="PreviewSection-requeryHint">
          {t("preview.requeryHintPre")}
          <span className="hint-pill" data-testid="PreviewSection-requeryHintPill">
            <SearchIcon size={9} className="inline-block align-middle" />
            {t("preview.runQuery")}
          </span>
          {t("preview.requeryHintPost")}
        </span>
        <span data-testid="PreviewSection-quickFilterHint">
          <span className="hint-pill">{t("preview.quickFilterHintKey")}</span>
          {t("preview.quickFilterHintPost")}
        </span>
      </div>

      <div className="scroll-area rounded-lg border"
           style={{ borderColor: "var(--hairline)", maxHeight: "26rem", overflow: "auto" }}>
        {data ? (
          <PreviewTable
            data={data}
            hidden={tab.hidden}
            wrapCells={wrapCells}
            highlightColumn={tab.highlight ?? null}
            sort={tab.sort}
            order={tab.order}
            onToggleHidden={(column) => onPatch(tab.id, {
              hidden: tab.hidden.includes(column)
                ? tab.hidden.filter((c) => c !== column)
                : [...tab.hidden, column],
            })}
            onSort={(sort) => onPatch(tab.id, { sort })}
            onReorder={(order) => onPatch(tab.id, { order })}
            // 셀 더블클릭·고유값 메뉴 → 조건 스테이징 (조회는 [조회] 버튼이 낸다)
            onQuickFilter={(column, value, op = "eq") => appendFilter(
              value === null || value === undefined
                ? { column, op: op === "neq" ? "not_null" : "is_null", value: null }
                : { column, op, value: String(value) },
            )}
            onExcludeNulls={excludeNulls}
            onPickFilterColumn={pickFilterColumn}
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
  tabs, activeId, splitId, onActivate, onClose, onSplitPick, onRefetch, onPatch, onJumpToTop,
}: Props) {
  const { t } = useI18n();
  // 긴 값 표시 모드 — 기본은 말줄임(첫 화면 가독성), 전체를 봐야 할 때만 줄바꿈.
  // 페인이 아니라 섹션이 들고 있어 분할 시 두 페인이 같은 모드로 움직인다
  // / long values ellipsize by default; the section owns the mode so split panes agree
  const [wrapCells, setWrapCells] = useState(false);
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
        <div className="ml-auto flex items-center gap-1.5">
          {tabs.length >= 2 && (
            <button
              className="icon-button"
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
              <SplitIcon size={11} className="mr-1 inline-block align-middle" />
              {splitId !== null ? t("preview.single") : t("preview.split")}
            </button>
          )}
          {/* 긴 값: 말줄임 ↔ 자동 줄바꿈 / long-value display mode */}
          <button
            className="icon-button"
            title={t("preview.cellModeTitle")}
            aria-pressed={wrapCells}
            onClick={() => setWrapCells((cur) => !cur)}
            data-testid="PreviewSection-cellModeButton"
          >
            {wrapCells
              ? <EllipsisTextIcon size={11} className="mr-1 inline-block align-middle" />
              : <WrapTextIcon size={11} className="mr-1 inline-block align-middle" />}
            {wrapCells ? t("preview.ellipsisCells") : t("preview.wrapCells")}
          </button>
          <button
            className="icon-button"
            title={t("preview.backToTopTitle")}
            onClick={onJumpToTop}
            data-testid="PreviewSection-backToTopButton"
          >
            <ArrowUpIcon size={11} className="mr-1 inline-block align-middle" />
            {t("preview.backToTop")}
          </button>
        </div>
      </div>

      <div className="flex gap-5">
        {active && (
          <PreviewPane tab={active} wrapCells={wrapCells}
                       onRefetch={onRefetch} onPatch={onPatch} />
        )}
        {split && split.id !== active?.id && (
          <PreviewPane tab={split} wrapCells={wrapCells}
                       onRefetch={onRefetch} onPatch={onPatch} />
        )}
      </div>
    </section>
  );
}
