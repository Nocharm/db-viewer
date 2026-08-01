"use client";

/** 좌측 2열 — 테이블명 목록 + 이름 필터 / table list with a name filter. */

import type { ObjectSummary } from "@/lib/types";

interface Props {
  tables: ObjectSummary[];
  selectedId: number | null;
  query: string;
  onQuery: (value: string) => void;
  onSelect: (table: ObjectSummary) => void;
}

export function TableList({ tables, selectedId, query, onQuery, onSelect }: Props) {
  return (
    <aside
      className="flex w-72 shrink-0 flex-col border-r"
      style={{ borderColor: "var(--hairline)" }}
      data-testid="TableList-root"
    >
      <div className="p-2.5">
        <input
          className="w-full rounded border px-3 py-1.5 text-sm outline-none transition-colors duration-200 ease-in-out focus:border-[var(--focus-blue)]"
          style={{ borderColor: "var(--border-light)" }}
          placeholder="테이블명 필터"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          data-testid="TableList-filterInput"
        />
      </div>
      <div className="scroll-area min-h-0 flex-1 pb-2">
        {tables.map((table) => (
          <button
            key={table.id}
            className={`pressable list-row ${selectedId === table.id ? "list-row--selected" : ""}`}
            onClick={() => onSelect(table)}
            data-testid={`TableList-item-${table.id}`}
          >
            <span className="flex-1 truncate font-mono text-xs">{table.name}</span>
            <span className="text-xs" style={{ color: "var(--muted)" }}>
              {table.column_count}c
            </span>
          </button>
        ))}
        {tables.length === 0 && (
          <p className="px-3 py-2 text-sm" style={{ color: "var(--muted)" }}
             data-testid="TableList-emptyState">
            조건에 맞는 테이블 없음
          </p>
        )}
      </div>
    </aside>
  );
}
