"use client";

/** 좌측 2열 — 테이블명 목록 + 강화 검색(초성·컬럼·하이라이트). / table list with rich search. */

import { useEffect, useRef, useState } from "react";

import { useI18n } from "@/components/i18n";
import { InfoTip } from "@/components/InfoTip";
import type { SearchMatch } from "@/lib/search";
import type { ObjectSummary } from "@/lib/types";

export interface TableListItem {
  table: ObjectSummary;
  match: SearchMatch;
}

interface Props {
  items: TableListItem[];
  selectedId: number | null;
  query: string;
  typeFilter: "all" | "table" | "view";
  onQuery: (value: string) => void;
  onTypeFilter: (value: "all" | "table" | "view") => void;
  onSelect: (table: ObjectSummary) => void;
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

// 한 번에 그리는 행 수 — 실규모 3,224개를 통째로 그리면 프레임이 끊긴다
// rows rendered per chunk; drawing all 3,224 at once janks the frame
const RENDER_CHUNK = 100;

const TYPE_FILTERS = [
  { value: "all", labelKey: "erd.typeAll" },
  { value: "table", labelKey: "erd.typeTable" },
  { value: "view", labelKey: "erd.typeView" },
] as const;

export function TableList({
  items, selectedId, query, typeFilter, onQuery, onTypeFilter, onSelect,
}: Props) {
  const { t } = useI18n();
  // 검색·필터로 목록이 바뀌면 처음 청크부터 다시 그린다 / restart chunking on a new result set
  const [visibleCount, setVisibleCount] = useState(RENDER_CHUNK);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setVisibleCount(RENDER_CHUNK);
  }, [items]);

  // 바닥 도달 → 다음 청크 (AdUserList와 같은 패턴) / append the next chunk at the bottom
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || visibleCount >= items.length) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        setVisibleCount((current) => current + RENDER_CHUNK);
      }
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visibleCount, items.length]);

  const shown = items.slice(0, visibleCount);

  return (
    <aside
      className="card flex max-h-[60vh] w-80 min-w-0 grow flex-col lg:max-h-none lg:grow-0"
      data-testid="TableList-root"
    >
      <div className="p-3 pb-2">
        <input
          className="w-full rounded-lg border px-3.5 py-2 text-sm outline-none transition-colors duration-200 ease-in-out focus:border-[var(--focus-blue)]"
          style={{ borderColor: "var(--border-light)" }}
          placeholder={t("tablelist.searchPlaceholder")}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          data-testid="TableList-filterInput"
        />
        {/* 타입 필터 — 뷰도 1급 시민 / views browse like tables */}
        <div className="mt-2 flex items-center gap-1.5">
          {TYPE_FILTERS.map(({ value, labelKey }) => (
            <button
              key={value}
              className={`pressable key-chip ${typeFilter === value ? "key-chip--selected" : ""}`}
              onClick={() => onTypeFilter(value)}
              data-testid={`TableList-typeChip-${value}`}
            >
              {t(labelKey)}
            </button>
          ))}
          <InfoTip text={t("tip.tableList")} />
        </div>
        {/* 전체 개수 표기 — 목록이 잘려 보이는지 아닌지를 화면에서 판별할 수 있어야 한다 */}
        <p className="mt-2 text-[11px]" style={{ color: "var(--muted)" }}
           data-testid="TableList-count">
          {items.length.toLocaleString()}{t("tablelist.countSuffix")}
        </p>
      </div>
      <div className="scroll-area min-h-0 flex-1 pb-3">
        {shown.map(({ table, match }) => (
          <button
            key={table.id}
            className={`pressable list-row ${selectedId === table.id ? "list-row--selected" : ""}`}
            onClick={() => onSelect(table)}
            data-testid={`TableList-item-${table.id}`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-xs">
                <span className={`obj-chip mr-1.5 ${table.type === "view" ? "obj-chip--view" : ""}`}>
                  {table.type === "view" ? "V" : "T"}
                </span>
                <Highlight text={table.name} range={match.nameRange} />
              </span>
              {match.matchedColumn && (
                <span className="mt-0.5 block truncate text-[11px]"
                      style={{ color: "var(--slate)" }}>
                  {t("tablelist.columnPrefix")}: <Highlight text={match.matchedColumn} range={match.columnRange} />
                </span>
              )}
            </span>
            <span className="text-xs" style={{ color: "var(--muted)" }}>
              {table.column_count}c
            </span>
          </button>
        ))}
        {items.length === 0 && (
          <p className="px-4 py-3 text-sm" style={{ color: "var(--muted)" }}
             data-testid="TableList-emptyState">
            {t("tablelist.empty")}
          </p>
        )}
        {visibleCount < items.length && (
          <div ref={sentinelRef} className="px-4 py-3 text-center text-xs"
               style={{ color: "var(--muted)" }}
               data-testid="TableList-loadMoreSentinel">
            {t("detail.loading")}
          </div>
        )}
      </div>
    </aside>
  );
}
