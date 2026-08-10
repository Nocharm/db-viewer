"use client";

/** 좌측 1열 — 카테고리 탭 / DB 탭 (스키마 필터·카테고리 편집).
 * Left rail: category tab plus a DB tab that filters and re-categorizes schemas. */

import { useMemo, useState } from "react";

import { useI18n } from "@/components/i18n";
import { PencilIcon } from "@/components/icons";
import { InfoTip } from "@/components/InfoTip";
import { PreviewLockMarks } from "@/components/PreviewLockMarks";
import type { SchemaCategoryItem } from "@/lib/api";
import { getCategoryLockStates } from "@/lib/category";

export interface CategoryEntry {
  code: string;
  label: string;
  count: number;
}

interface Props {
  categories: CategoryEntry[];
  selected: string | null;
  totalCount: number;
  onSelect: (code: string | null) => void;
  /** DB 탭 — 스키마 목록·객체 수·현재 카테고리 / schema rows for the DB tab */
  schemas: SchemaCategoryItem[];
  /** 체크된 스키마. 빈 배열이면 필터 없음 / empty means no filter */
  dbFilter: string[];
  onDbFilter: (schemas: string[]) => void;
  onAssignCategory: (schema: string, category: string) => void;
  /** 미리보기 허용 스키마 — 미허용 행에 잠금 아이콘 / preview allowlist for lock markers */
  previewAllowed: Set<string>;
}

type Tab = "category" | "db";

export function CategoryList({
  categories, selected, totalCount, onSelect,
  schemas, dbFilter, onDbFilter, onAssignCategory, previewAllowed,
}: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("category");
  // 편집 중인 스키마 — 입력창을 그 행에만 띄운다 / inline editor for one row
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const filterActive = dbFilter.length > 0;

  // 카테고리별 허용/미허용 집계 — DB가 혼재한 카테고리는 풀림·잠김을 같이 띄운다
  const lockStates = useMemo(
    () => getCategoryLockStates(schemas, previewAllowed), [schemas, previewAllowed]);
  const totalLock = useMemo(() => ({
    hasAllowed: schemas.some((s) => previewAllowed.has(s.schema)),
    hasLocked: schemas.some((s) => !previewAllowed.has(s.schema)),
  }), [schemas, previewAllowed]);

  const toggleSchema = (schema: string) => {
    onDbFilter(
      dbFilter.includes(schema)
        ? dbFilter.filter((s) => s !== schema)
        : [...dbFilter, schema],
    );
  };

  const commitEdit = (schema: string) => {
    onAssignCategory(schema, draft.trim());
    setEditing(null);
  };

  return (
    <aside
      className="card scroll-area scroll-area--y max-h-[60vh] w-44 shrink-0 pb-3 lg:max-h-none"
      data-testid="CategoryList-root"
    >
      {/* 탭 헤더는 스크롤해도 남는다 — 목록이 길어도 탭 전환이 항상 손에 닿게 */}
      <div
        className="sticky top-0 z-10 flex flex-wrap items-center gap-1 px-3 pt-3 pb-2"
        style={{ background: "var(--surface-card)" }}
        data-testid="CategoryList-tabs"
      >
        <button
          className={`pressable key-chip ${tab === "category" ? "key-chip--selected" : ""}`}
          onClick={() => setTab("category")}
          data-testid="CategoryList-tab-category"
        >
          {t("browser.categories")}
        </button>
        <button
          className={`pressable key-chip ${tab === "db" ? "key-chip--selected" : ""}`}
          onClick={() => setTab("db")}
          data-testid="CategoryList-tab-db"
        >
          {t("browser.dbTab")}
          {/* 필터가 걸려 있으면 탭에 개수 표시 — 목록이 왜 짧은지 화면에서 드러나야 한다 */}
          {filterActive && (
            <span className="ml-1 font-semibold" style={{ color: "var(--stat-ink)" }}
                  data-testid="CategoryList-dbFilterBadge">
              {dbFilter.length}
            </span>
          )}
        </button>
        <InfoTip text={t(tab === "db" ? "tip.dbFilter" : "tip.categories")} align="right" />
      </div>

      {tab === "category" && (
        <>
          <button
            className={`pressable list-row ${selected === null ? "list-row--selected" : ""}`}
            onClick={() => onSelect(null)}
            data-testid="CategoryList-all"
          >
            <span className="flex-1">{t("category.all")}</span>
            <PreviewLockMarks {...totalLock}
                              allowedTitle={t("preview.categoryHasAllowed")}
                              lockedTitle={t("preview.categoryHasLocked")}
                              testidPrefix="CategoryList-all" />
            <span className="text-xs" style={{ color: "var(--muted)" }}>{totalCount}</span>
          </button>
          {categories.map((category) => {
            const lockState = lockStates.get(category.code);
            return (
              <button
                key={category.code}
                className={`pressable list-row ${selected === category.code ? "list-row--selected" : ""}`}
                onClick={() => onSelect(category.code)}
                data-testid={`CategoryList-item-${category.code}`}
              >
                <span className="flex-1 truncate">{category.label}</span>
                {lockState && (
                  <PreviewLockMarks hasAllowed={lockState.hasAllowed}
                                    hasLocked={lockState.hasLocked}
                                    allowedTitle={t("preview.categoryHasAllowed")}
                                    lockedTitle={t("preview.categoryHasLocked")}
                                    testidPrefix={`CategoryList-cat-${category.code}`} />
                )}
                <span className="text-xs" style={{ color: "var(--muted)" }}>{category.count}</span>
              </button>
            );
          })}
        </>
      )}

      {tab === "db" && (
        <>
          {/* 밑줄 링크 대신 버튼 — "보기/선택"이 형제 워딩이라 컨트롤 형태로 구분한다 */}
          <div className="flex items-center gap-1 px-3 pb-1.5">
            <button className="icon-button text-[11px]"
                    onClick={() => onDbFilter([])}
                    data-testid="CategoryList-dbFilterClear">
              {t("db.showAll")}
            </button>
            <button className="icon-button text-[11px]"
                    onClick={() => onDbFilter(schemas.map((s) => s.schema))}
                    data-testid="CategoryList-dbFilterAll">
              {t("db.checkAll")}
            </button>
          </div>
          {schemas.map((item) => (
            // 한 줄 행 — 필터(체크박스+이름)와 분류 편집(칩)을 같은 줄에서 역할별로 나눈다.
            // 칩은 label 밖 — label 안에 두면 칩 클릭이 체크까지 토글한다
            // / one-line row: the chip sits outside the label so editing never toggles the filter
            <div key={item.schema} className="group px-3 py-1"
                 data-testid={`CategoryList-dbRow-${item.schema}`}>
              <div className="flex items-center gap-1.5 text-xs">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={dbFilter.includes(item.schema)}
                    onChange={() => toggleSchema(item.schema)}
                    data-testid={`CategoryList-dbCheck-${item.schema}`}
                  />
                  <span className="min-w-0 truncate font-mono">{item.schema}</span>
                </label>
                {item.mapped ? (
                  <button
                    className="pressable inline-flex max-w-20 items-center gap-1 rounded-full px-2 py-0.5 text-[10px]"
                    style={{ background: "var(--surface-elevated)", color: "var(--slate)" }}
                    onClick={() => {
                      setDraft(item.category);
                      setEditing(item.schema);
                    }}
                    title={t("db.editCategory")}
                    data-testid={`CategoryList-dbCategoryButton-${item.schema}`}
                  >
                    <span className="truncate">{item.category}</span>
                    {/* 연필은 행 호버에만 — opacity라 자리가 흔들리지 않는다 */}
                    <PencilIcon size={10}
                                className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                  </button>
                ) : (
                  // 미지정 — 스키마명을 반복하는 대신 지정을 유도하는 고스트 칩
                  <button
                    className="pressable rounded-full border border-dashed px-2 py-0.5 text-[10px]"
                    style={{ borderColor: "var(--hairline-strong)", color: "var(--muted)" }}
                    onClick={() => {
                      setDraft("");
                      setEditing(item.schema);
                    }}
                    title={t("db.editCategory")}
                    data-testid={`CategoryList-dbCategoryButton-${item.schema}`}
                  >
                    {t("db.addCategory")}
                  </button>
                )}
                <PreviewLockMarks hasAllowed={previewAllowed.has(item.schema)}
                                  hasLocked={!previewAllowed.has(item.schema)}
                                  allowedTitle={t("preview.schemaAllowed")}
                                  lockedTitle={t("preview.schemaLocked")}
                                  testidPrefix={`CategoryList-db-${item.schema}`} />
                <span style={{ color: "var(--muted)" }}>{item.object_count}</span>
              </div>
              {/* 편집 중에만 임시 2줄 — 입력이 끝나면 한 줄로 복귀 */}
              {editing === item.schema && (
                <input
                  className="mt-1 w-full rounded border px-1.5 py-0.5 text-[11px] outline-none focus:border-[var(--focus-blue)]"
                  style={{ borderColor: "var(--border-light)" }}
                  autoFocus
                  value={draft}
                  placeholder={t("db.categoryPlaceholder")}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitEdit(item.schema)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitEdit(item.schema);
                    if (e.key === "Escape") setEditing(null);
                  }}
                  data-testid={`CategoryList-dbCategoryInput-${item.schema}`}
                />
              )}
            </div>
          ))}
        </>
      )}
    </aside>
  );
}
