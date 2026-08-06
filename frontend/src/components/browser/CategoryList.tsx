"use client";

/** 좌측 1열 — 카테고리 탭 / DB 탭 (스키마 필터·카테고리 편집).
 * Left rail: category tab plus a DB tab that filters and re-categorizes schemas. */

import { useState } from "react";

import { useI18n } from "@/components/i18n";
import { InfoTip } from "@/components/InfoTip";
import type { SchemaCategoryItem } from "@/lib/api";

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
}

type Tab = "category" | "db";

export function CategoryList({
  categories, selected, totalCount, onSelect,
  schemas, dbFilter, onDbFilter, onAssignCategory,
}: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("category");
  // 편집 중인 스키마 — 입력창을 그 행에만 띄운다 / inline editor for one row
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const filterActive = dbFilter.length > 0;

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
            <span className="text-xs" style={{ color: "var(--muted)" }}>{totalCount}</span>
          </button>
          {categories.map((category) => (
            <button
              key={category.code}
              className={`pressable list-row ${selected === category.code ? "list-row--selected" : ""}`}
              onClick={() => onSelect(category.code)}
              data-testid={`CategoryList-item-${category.code}`}
            >
              <span className="flex-1 truncate">{category.label}</span>
              <span className="text-xs" style={{ color: "var(--muted)" }}>{category.count}</span>
            </button>
          ))}
        </>
      )}

      {tab === "db" && (
        <>
          <div className="flex items-center gap-1 px-3 pb-1.5">
            <button className="pressable text-[11px] underline"
                    style={{ color: "var(--slate)" }}
                    onClick={() => onDbFilter([])}
                    data-testid="CategoryList-dbFilterClear">
              {t("db.showAll")}
            </button>
            <button className="pressable text-[11px] underline"
                    style={{ color: "var(--slate)" }}
                    onClick={() => onDbFilter(schemas.map((s) => s.schema))}
                    data-testid="CategoryList-dbFilterAll">
              {t("db.checkAll")}
            </button>
          </div>
          {schemas.map((item) => (
            <div key={item.schema} className="px-3 py-1"
                 data-testid={`CategoryList-dbRow-${item.schema}`}>
              <label className="flex cursor-pointer items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={dbFilter.includes(item.schema)}
                  onChange={() => toggleSchema(item.schema)}
                  data-testid={`CategoryList-dbCheck-${item.schema}`}
                />
                <span className="min-w-0 flex-1 truncate font-mono">{item.schema}</span>
                <span style={{ color: "var(--muted)" }}>{item.object_count}</span>
              </label>
              {editing === item.schema ? (
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
              ) : (
                <button
                  className="pressable mt-0.5 block w-full truncate text-left text-[11px]"
                  // 지정값은 진하게, 기본값(스키마명)은 흐리게 — 한눈에 구분
                  style={{ color: item.mapped ? "var(--slate)" : "var(--muted)" }}
                  onClick={() => {
                    setDraft(item.mapped ? item.category : "");
                    setEditing(item.schema);
                  }}
                  title={t("db.editCategory")}
                  data-testid={`CategoryList-dbCategoryButton-${item.schema}`}
                >
                  {item.category}
                </button>
              )}
            </div>
          ))}
        </>
      )}
    </aside>
  );
}
