"use client";

/** 스키마·객체를 한 열로 합친 트리 — 3열 레이아웃의 대안.
 *
 * 3열(카테고리 레일 + 목록 + 상세)은 가로를 세 번 나눠 쓴다. 좁은 화면에서는 상세가 먼저
 * 죽고, 계보 맵처럼 가로를 크게 먹는 화면이 들어오면 3열로는 자리가 안 난다. 트리는 같은
 * 정보를 한 열에 접어 넣고, 더 좁아지면 「선택된 행」만 플로팅으로 남긴다.
 * / one column instead of two rails; collapses further to a single floating row.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "@/components/i18n";
import { CaretDownIcon, CaretRightIcon, CloseIcon, FilterIcon } from "@/components/icons";
import type { SchemaCategoryItem } from "@/lib/api";
import type { ObjectSummary } from "@/lib/types";
import { useHiddenSchemas } from "@/lib/use-hidden-schemas";
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
  /** 필터 모달의 스키마 목록 — 체크된 것만 보여준다(빈 배열 = 필터 없음) */
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

/** 트리 본체 — 창(pane)과 드롭다운이 같은 것을 쓴다. */
export function ObjectTree(props: ObjectTreeProps & { showSearch?: boolean }) {
  const { items, selected, query, typeFilter, onQuery, onTypeFilter, onSelect } = props;
  const { t } = useI18n();
  const hiddenSchemas = useHiddenSchemas();
  const [filterOpen, setFilterOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(RENDER_CHUNK);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const groups = useMemo(() => groupBySchema(items), [items]);

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
  const isCollapsed = (schema: string) => {
    if (searching) return false;
    if (collapsed.has(schema)) return true;
    return groups.length > AUTO_EXPAND_LIMIT
      && !collapsed.has(`!${schema}`)
      && selected?.schema !== schema;
  };
  const toggleGroup = (schema: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      // 자동 접힘 상태를 사용자가 펼치면 `!schema`로 "직접 펼침"을 기록한다
      if (isCollapsed(schema)) { next.delete(schema); next.add(`!${schema}`); }
      else { next.delete(`!${schema}`); next.add(schema); }
      return next;
    });
  };

  let drawn = 0;
  const filterActive = props.dbFilter.length > 0;

  return (
    <div className="tree-pane h-full" data-testid="ObjectTree-root">
      {props.showSearch !== false && (
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
            className={`icon-button shrink-0 ${filterActive ? "!text-[var(--stat-ink)]" : ""}`}
            onClick={() => setFilterOpen(true)}
            title={t("tree.filterTitle")}
            data-testid="ObjectTree-filterButton"
          >
            <FilterIcon size={12} />
            {filterActive && ` ${props.dbFilter.length}`}
          </button>
        </div>
      )}

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

      {filterOpen && (
        <SchemaFilterModal
          schemas={props.schemas}
          dbFilter={props.dbFilter}
          onDbFilter={props.onDbFilter}
          onClose={() => setFilterOpen(false)}
        />
      )}
    </div>
  );
}

/** 스키마 체크 목록 — 3열 레이아웃의 DB 탭이 하던 필터를 모달로 옮겨 담았다. */
function SchemaFilterModal({
  schemas, dbFilter, onDbFilter, onClose,
}: {
  schemas: SchemaCategoryItem[];
  dbFilter: string[];
  onDbFilter: (next: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = (schema: string) => {
    onDbFilter(dbFilter.includes(schema)
      ? dbFilter.filter((item) => item !== schema)
      : [...dbFilter, schema]);
  };

  return (
    <div className="modal-backdrop" onClick={onClose} data-testid="SchemaFilterModal-backdrop">
      <div className="modal" style={{ width: "min(520px, 100%)" }}
           onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t("tree.filterTitle")}>
        <div className="modal__head">
          <h3 className="modal__title">{t("tree.filterTitle")}</h3>
          <button className="icon-button modal__close" onClick={onClose}
                  data-testid="SchemaFilterModal-closeButton">
            <CloseIcon size={12} />
          </button>
        </div>
        <div className="scroll-area" style={{ maxHeight: "50vh", overflowY: "auto" }}>
          {schemas.map((schema) => (
            <label key={schema.schema}
                   className="flex cursor-pointer items-center gap-2 px-1 py-1.5 text-sm">
              <input
                type="checkbox"
                checked={dbFilter.includes(schema.schema)}
                onChange={() => toggle(schema.schema)}
                data-testid={`SchemaFilterModal-check-${schema.schema}`}
              />
              <span className="font-mono text-xs" style={{ color: "var(--ink)" }}>
                {schema.schema}
              </span>
              <span className="ml-auto text-xs" style={{ color: "var(--muted)" }}>
                {schema.object_count?.toLocaleString() ?? ""}
              </span>
            </label>
          ))}
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary !py-1 text-xs" onClick={() => onDbFilter([])}
                  data-testid="SchemaFilterModal-clearButton">
            {t("category.all")}
          </button>
          <button className="btn-primary !py-1 ml-auto text-xs" onClick={onClose}>
            {t("tree.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 좁은 폭 — 선택된 행 하나만 남고, 누르면 트리가 드롭다운으로 내려온다. */
export function ObjectTreeFloating(props: ObjectTreeProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

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

  const { selected } = props;

  return (
    <div ref={boxRef} className="relative w-full" data-testid="ObjectTreeFloating-root">
      <button
        className="tree-float pressable"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        data-testid="ObjectTreeFloating-toggle"
      >
        {selected ? (
          <>
            <span className={`obj-chip ${selected.type === "view" ? "obj-chip--view" : ""}`}>
              {selected.type === "view" ? "V" : "T"}
            </span>
            <span className="tree-float__schema">{selected.schema}.</span>
            <span className="tree-float__name">{selected.name}</span>
          </>
        ) : (
          <span style={{ color: "var(--muted)" }}>{t("tree.none")}</span>
        )}
        <span className="tree-float__caret">
          {open ? <CaretDownIcon size={11} /> : <CaretRightIcon size={11} />}
        </span>
      </button>
      {open && (
        <div className="tree-drop" data-testid="ObjectTreeFloating-dropdown">
          <ObjectTree
            {...props}
            onSelect={(table) => { props.onSelect(table); setOpen(false); }}
          />
        </div>
      )}
    </div>
  );
}
