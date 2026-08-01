"use client";

/** 좌측 1열 — 테이블 카테고리 / business categories. */

import { useI18n } from "@/components/i18n";
import { InfoTip } from "@/components/InfoTip";

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
}

export function CategoryList({ categories, selected, totalCount, onSelect }: Props) {
  const { t } = useI18n();
  return (
    <aside
      className="card scroll-area max-h-[60vh] w-44 shrink-0 py-3 lg:max-h-none"
      data-testid="CategoryList-root"
    >
      <div className="flex items-center gap-1.5 px-4 pb-1.5">
        <span className="erd-node__type">{t("browser.categories")}</span>
        <InfoTip text={t("tip.categories")} align="right" />
      </div>
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
    </aside>
  );
}
