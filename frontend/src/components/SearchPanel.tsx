"use client";

/** 검색 → 앵커 선택 패널 / search-then-anchor panel (계획 §1.5 앵커 방식). */

import { useEffect, useState } from "react";

import { searchObjects, searchTablesAi } from "@/lib/api";
import type { ObjectSummary } from "@/lib/types";

interface Props {
  onSelect: (obj: ObjectSummary) => void;
  selectedId: number | null;
}

export function SearchPanel({ onSelect, selectedId }: Props) {
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState<"" | "table" | "view">("");
  const [items, setItems] = useState<ObjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (q.length < 2) {
      setItems([]);
      return;
    }
    const timer = setTimeout(() => {
      // '?'로 시작하면 AI 자연어 탐색 (계획 §5.1-2) / '?' prefix = AI search
      const isAi = q.startsWith("?");
      const request = isAi
        ? searchTablesAi(q.slice(1).trim()).then((res) =>
            res.items
              .filter((h) => h.object_id !== null)
              .map((h) => {
                const [schema, name] = h.object.split(".");
                return {
                  id: h.object_id as number, schema, name,
                  type: "table" as const, row_count: null,
                  column_count: 0, dmv_unresolved: false,
                };
              }))
        : searchObjects(q, typeFilter || undefined).then((res) => res.items);
      request
        .then((list) => {
          setItems(list);
          setError(null);
        })
        .catch((e) => setError(e.message));
    }, 200); // 타이핑 디바운스 / debounce
    return () => clearTimeout(timer);
  }, [q, typeFilter]);

  return (
    <aside
      className="flex h-full w-72 flex-col border-r"
      style={{ borderColor: "var(--hairline)" }}
      data-testid="SearchPanel-root"
    >
      <div className="p-3">
        <input
          className="w-full rounded border px-3 py-2 text-sm outline-none focus:border-[var(--focus-blue)]"
          style={{ borderColor: "var(--border-light)" }}
          placeholder="검색 (2자+) — ?로 시작하면 AI 탐색"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="SearchPanel-queryInput"
        />
        <select
          className="mt-2 w-full rounded border px-2 py-1.5 text-sm"
          style={{ borderColor: "var(--border-light)" }}
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as "" | "table" | "view")}
          data-testid="SearchPanel-typeSelect"
        >
          <option value="">전체</option>
          <option value="table">테이블</option>
          <option value="view">뷰</option>
        </select>
      </div>

      {error && (
        <p className="px-3 text-sm" style={{ color: "var(--error)" }}
           data-testid="SearchPanel-errorText">
          {error}
        </p>
      )}

      <ul className="flex-1 overflow-y-auto" data-testid="SearchPanel-resultList">
        {items.map((item) => (
          <li key={item.id}>
            <button
              className="w-full px-3 py-2 text-left text-sm hover:bg-[var(--soft-stone)]"
              style={item.id === selectedId ? { background: "var(--soft-stone)" } : undefined}
              onClick={() => onSelect(item)}
              data-testid={`SearchPanel-item-${item.id}`}
            >
              <span className="erd-node__type mr-1.5">
                {item.type === "view" ? "VIEW" : "TBL"}
              </span>
              {item.schema}.{item.name}
              <span className="float-right" style={{ color: "var(--muted)" }}>
                {item.column_count}c
              </span>
            </button>
          </li>
        ))}
        {q.length >= 2 && items.length === 0 && !error && (
          <li className="px-3 py-2 text-sm" style={{ color: "var(--muted)" }}
              data-testid="SearchPanel-emptyState">
            결과 없음
          </li>
        )}
      </ul>
    </aside>
  );
}
