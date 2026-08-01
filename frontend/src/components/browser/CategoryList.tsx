"use client";

/** 좌측 1열 — 테이블 카테고리 / business categories. */

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
  return (
    <aside
      className="scroll-area w-44 shrink-0 border-r py-2"
      style={{ borderColor: "var(--hairline)" }}
      data-testid="CategoryList-root"
    >
      <button
        className={`pressable list-row ${selected === null ? "list-row--selected" : ""}`}
        onClick={() => onSelect(null)}
        data-testid="CategoryList-all"
      >
        <span className="flex-1">전체</span>
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
