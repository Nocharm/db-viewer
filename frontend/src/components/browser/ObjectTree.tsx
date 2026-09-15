"use client";

/** 스키마·객체를 한 열로 합친 트리 — 평소엔 **한 줄**로 접혀 있다.
 *
 * 트리 배치에서는 좌측 열을 아예 두지 않는다. 대신 상세 패널의 **객체 이름 자리**가 곧
 * 선택 트리거다(`ObjectTreePicker`) — 지금 보고 있는 것과 다음에 고를 것이 같은 자리에
 * 있으니 눈이 움직이지 않고, 남은 가로 폭은 전부 상세·다이어그램이 쓴다.
 * / the map's own title is the picker: one row collapsed, the tree drops from it.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "@/components/i18n";
import { CaretDownIcon, CaretRightIcon, CloseIcon, FilterIcon } from "@/components/icons";
import type { SchemaCategoryItem } from "@/lib/api";
import type { ObjectSummary } from "@/lib/types";
import { useHiddenSchemas } from "@/lib/use-hidden-schemas";
import type { CategoryEntry } from "@/components/browser/CategoryList";
import type { TableListItem } from "@/components/browser/TableList";

/** 한 번에 그리는 객체 행 수 — 실규모 3,224개를 통째로 그리면 프레임이 끊긴다(TableList와 같은 패턴) */
const RENDER_CHUNK = 120;
/** 검색어 없이 자동으로 펼쳐 둘 스키마 수 상한 — 넘으면 접은 채로 시작한다 */
const AUTO_EXPAND_LIMIT = 3;

const TYPE_FILTERS = [
  { value: "all", labelKey: "tree.typeAll" },
  { value: "table", labelKey: "tree.typeTable" },
  { value: "view", labelKey: "tree.typeView" },
] as const;

export interface ObjectTreeProps {
  items: TableListItem[];
  selected: ObjectSummary | null;
  query: string;
  typeFilter: "all" | "table" | "view";
  onQuery: (value: string) => void;
  onTypeFilter: (value: "all" | "table" | "view") => void;
  onSelect: (table: ObjectSummary) => void;
  /** 3열의 카테고리 레일과 같은 축 — 플라이아웃에서 고른다 */
  categories: CategoryEntry[];
  category: string | null;
  onSelectCategory: (code: string | null) => void;
  /** 3열의 DB 탭과 같은 축 — 체크된 스키마만 보여준다(빈 배열 = 필터 없음) */
  schemas: SchemaCategoryItem[];
  dbFilter: string[];
  onDbFilter: (schemas: string[]) => void;
}

function Highlight({ text, range }: { text: string; range: [number, number] | null }) {
  if (!range) return <>{text}</>;
  return (
    <>
      {text.slice(0, range[0])}
      <mark className="hl">{text.slice(range[0], range[1])}</mark>
      {text.slice(range[1])}
    </>
  );
}

interface SchemaGroup {
  schema: string;
  items: TableListItem[];
}

function groupBySchema(items: TableListItem[]): SchemaGroup[] {
  const groups = new Map<string, TableListItem[]>();
  for (const item of items) {
    const bucket = groups.get(item.table.schema);
    if (bucket) bucket.push(item);
    else groups.set(item.table.schema, [item]);
  }
  return [...groups.entries()]
    .map(([schema, groupItems]) => ({ schema, items: groupItems }))
    .sort((a, b) => a.schema.localeCompare(b.schema));
}

/** 필터가 하나라도 걸려 있는가 — 배지와 「전부 해제」 활성 판단 */
export function countActiveFilters(props: Pick<
  ObjectTreeProps, "category" | "dbFilter" | "typeFilter"
>): number {
  return (props.category !== null ? 1 : 0)
    + (props.dbFilter.length > 0 ? 1 : 0)
    + (props.typeFilter !== "all" ? 1 : 0);
}

/** 트리 본체 — 검색줄 + 필터 플라이아웃 + 스키마 > 객체 목록. */
export function ObjectTree(props: ObjectTreeProps) {
  const { items, selected, query, typeFilter, onQuery, onTypeFilter, onSelect } = props;
  const { t } = useI18n();
  const hiddenSchemas = useHiddenSchemas();
  const [filterOpen, setFilterOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(RENDER_CHUNK);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const groups = useMemo(() => groupBySchema(items), [items]);
  const activeFilters = countActiveFilters(props);

  useEffect(() => { setVisibleCount(RENDER_CHUNK); }, [items]);

  // 바닥 도달 → 다음 청크 / append the next chunk at the bottom
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || visibleCount >= items.length) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) setVisibleCount((current) => current + RENDER_CHUNK);
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visibleCount, items.length]);

  // 검색 중에는 전부 펼친다 — 접힌 그룹 안에 답이 있으면 "결과 없음"으로 읽힌다.
  // 검색어가 없고 그룹이 많으면 접은 채로 시작해 스키마 지도를 먼저 보여준다.
  const searching = query.trim() !== "";
  const autoFolded = (schema: string) => groups.length > AUTO_EXPAND_LIMIT
    && selected?.schema !== schema;
  const isCollapsed = (schema: string) => {
    if (searching) return false;
    if (collapsed.has(schema)) return true;
    return autoFolded(schema) && !collapsed.has(`!${schema}`);
  };
  const toggleGroup = (schema: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      // 자동 접힘 상태를 사용자가 펼치면 `!schema`로 "직접 펼침"을 기록한다
      const folded = searching
        ? false
        : current.has(schema) || (autoFolded(schema) && !current.has(`!${schema}`));
      if (folded) { next.delete(schema); next.add(`!${schema}`); }
      else { next.delete(`!${schema}`); next.add(schema); }
      return next;
    });
  };

  let drawn = 0;

  return (
    <div className="tree-pane" data-testid="ObjectTree-root">
      <div className="tree-head">
        <input
          className="w-full min-w-0 rounded-lg border px-3 py-1.5 text-sm outline-none transition-colors duration-200 focus:border-[var(--focus-blue)]"
          style={{ borderColor: "var(--border-light)" }}
          placeholder={t("tree.searchPlaceholder")}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          data-testid="ObjectTree-searchInput"
        />
        <button
          className="icon-button shrink-0"
          style={activeFilters > 0 ? { color: "var(--stat-ink)" } : undefined}
          aria-expanded={filterOpen}
          onClick={() => setFilterOpen((current) => !current)}
          title={t("tree.filterTitle")}
          data-testid="ObjectTree-filterButton"
        >
          <FilterIcon size={12} />
          {activeFilters > 0 && ` ${activeFilters}`}
        </button>
      </div>

      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        {TYPE_FILTERS.map(({ value, labelKey }) => (
          <button
            key={value}
            className={`pressable key-chip ${typeFilter === value ? "key-chip--selected" : ""}`}
            onClick={() => onTypeFilter(value)}
            data-testid={`ObjectTree-typeChip-${value}`}
          >
            {t(labelKey)}
          </button>
        ))}
        <span className="ml-auto text-[11px]" style={{ color: "var(--muted)" }}
              data-testid="ObjectTree-count">
          {groups.length}{t("tree.schemaCount")} · {items.length.toLocaleString()}
          {t("tablelist.countSuffix")}
        </span>
      </div>

      <div className="tree-body scroll-area">
        {groups.length === 0 && (
          <p className="px-3 py-2 text-xs" style={{ color: "var(--muted)" }}
             data-testid="ObjectTree-empty">
            {t("tree.empty")}
          </p>
        )}
        {groups.map((group) => {
          const folded = isCollapsed(group.schema);
          return (
            <div key={group.schema}>
              <button
                className="tree-group pressable"
                aria-expanded={!folded}
                onClick={() => toggleGroup(group.schema)}
                data-testid={`ObjectTree-group-${group.schema}`}
              >
                {folded ? <CaretRightIcon size={10} /> : <CaretDownIcon size={10} />}
                <span className="tree-group__name">{group.schema}</span>
                <span className="tree-group__count">{group.items.length}</span>
              </button>
              {!folded && group.items.map(({ table, match }) => {
                if (drawn >= visibleCount) return null;
                drawn += 1;
                const hidden = hiddenSchemas.has(table.schema.toLowerCase());
                return (
                  <button
                    key={table.id}
                    className="tree-item pressable"
                    aria-current={selected?.id === table.id}
                    disabled={hidden}
                    title={hidden ? t("hidden.notNavigable") : `${table.column_count} columns`}
                    onClick={() => onSelect(table)}
                    data-testid={`ObjectTree-item-${table.id}`}
                  >
                    <span className={`obj-chip ${table.type === "view" ? "obj-chip--view" : ""}`}>
                      {table.type === "view" ? "V" : "T"}
                    </span>
                    <span className="tree-item__name">
                      <Highlight text={table.name} range={match.nameRange} />
                      {match.matchedColumn && (
                        <span style={{ color: "var(--slate)" }}>
                          {" · "}
                          <Highlight text={match.matchedColumn} range={match.columnRange} />
                        </span>
                      )}
                    </span>
                    <span className="tree-item__type">
                      {hidden ? t("hidden.badge") : `${table.column_count}c`}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
        <div ref={sentinelRef} />
      </div>

      {filterOpen && <FilterFlyout {...props} onClose={() => setFilterOpen(false)} />}
    </div>
  );
}

/** 필터 플라이아웃 — 트리 위로 옆에서 밀려 들어온다.
 * 3열 배치의 두 축(카테고리 레일 + DB 탭)을 그대로 담고, 전부 해제도 여기서 한다. */
function FilterFlyout({
  categories, category, onSelectCategory, schemas, dbFilter, onDbFilter,
  typeFilter, onTypeFilter, onClose,
}: ObjectTreeProps & { onClose: () => void }) {
  const { t } = useI18n();
  const hiddenSchemas = useHiddenSchemas();
  const active = countActiveFilters({ category, dbFilter, typeFilter });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggleSchema = (schema: string) => {
    onDbFilter(dbFilter.includes(schema)
      ? dbFilter.filter((item) => item !== schema)
      : [...dbFilter, schema]);
  };

  return (
    <div className="tree-flyout" role="dialog" aria-label={t("tree.filterTitle")}
         data-testid="ObjectTree-filterFlyout">
      <div className="tree-flyout__head">
        <span className="tree-flyout__title">{t("tree.filterTitle")}</span>
        <button className="icon-button !p-1 ml-auto" onClick={onClose}
                data-testid="ObjectTree-filterCloseButton">
          <CloseIcon size={11} />
        </button>
      </div>

      <div className="tree-flyout__body scroll-area">
        <section>
          <p className="tree-flyout__label">{t("tree.filterType")}</p>
          <div className="flex flex-wrap gap-1.5">
            {TYPE_FILTERS.map(({ value, labelKey }) => (
              <button
                key={value}
                className={`pressable key-chip ${typeFilter === value ? "key-chip--selected" : ""}`}
                onClick={() => onTypeFilter(value)}
                data-testid={`ObjectTree-filterType-${value}`}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
        </section>

        <section>
          <p className="tree-flyout__label">{t("tree.filterCategory")}</p>
          <div className="flex flex-wrap gap-1.5">
            <button
              className={`pressable key-chip ${category === null ? "key-chip--selected" : ""}`}
              onClick={() => onSelectCategory(null)}
              data-testid="ObjectTree-filterCategory-all"
            >
              {t("category.all")}
            </button>
            {categories.map((entry) => (
              <button
                key={entry.code}
                className={`pressable key-chip ${category === entry.code ? "key-chip--selected" : ""}`}
                onClick={() => onSelectCategory(category === entry.code ? null : entry.code)}
                data-testid={`ObjectTree-filterCategory-${entry.code}`}
              >
                {entry.label}
                <span className="key-chip__count">{entry.count}</span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <p className="tree-flyout__label">
            {t("tree.filterSchema")}
            {dbFilter.length > 0 && (
              <button className="tree-flyout__clear" onClick={() => onDbFilter([])}
                      data-testid="ObjectTree-filterSchemaClear">
                {t("tree.clearOne")}
              </button>
            )}
          </p>
          <div className="tree-flyout__schemas">
            {schemas.map((schema) => (
              <label key={schema.schema} className="tree-flyout__check">
                <input
                  type="checkbox"
                  checked={dbFilter.includes(schema.schema)}
                  onChange={() => toggleSchema(schema.schema)}
                  data-testid={`ObjectTree-filterSchema-${schema.schema}`}
                />
                <span className="font-mono text-xs" style={{ color: "var(--ink)" }}>
                  {schema.schema}
                </span>
                {hiddenSchemas.has(schema.schema.toLowerCase()) && (
                  <span className="badge badge--muted">{t("hidden.badge")}</span>
                )}
                <span className="ml-auto text-xs" style={{ color: "var(--muted)" }}>
                  {schema.object_count.toLocaleString()}
                </span>
              </label>
            ))}
          </div>
        </section>
      </div>

      <div className="tree-flyout__foot">
        <button
          className="btn-secondary !py-1 text-xs"
          disabled={active === 0}
          onClick={() => { onSelectCategory(null); onDbFilter([]); onTypeFilter("all"); }}
          data-testid="ObjectTree-filterClearAll"
        >
          {t("tree.clearAll")}
        </button>
        <button className="btn-primary !py-1 ml-auto text-xs" onClick={onClose}>
          {t("tree.close")}
        </button>
      </div>
    </div>
  );
}

/** 한 줄 선택기 — 상세 패널의 객체 이름 자리에 선다. 누르면 트리가 아래로 내려온다. */
export function ObjectTreePicker(props: ObjectTreeProps & { title: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const { selected, title } = props;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const activeFilters = countActiveFilters(props);

  return (
    <div ref={boxRef} className="tree-picker" data-testid="ObjectTreePicker-root">
      <button
        className="tree-picker__trigger pressable"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((current) => !current)}
        title={t("tree.pick")}
        data-testid="ObjectTreePicker-toggle"
      >
        <span className="tree-picker__name">{title}</span>
        {activeFilters > 0 && (
          <span className="badge badge--muted" data-testid="ObjectTreePicker-filterBadge">
            {t("tree.filter")} {activeFilters}
          </span>
        )}
        <span className="tree-picker__caret">
          {open ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
        </span>
      </button>
      {open && (
        <div className="tree-drop" data-testid="ObjectTreePicker-dropdown">
          <ObjectTree
            {...props}
            onSelect={(table) => { props.onSelect(table); setOpen(false); }}
          />
        </div>
      )}
      {selected === null && (
        <span className="sr-only" data-testid="ObjectTreePicker-empty">{t("tree.none")}</span>
      )}
    </div>
  );
}
