"use client";

/** 검색 → 앵커 선택 패널 / search-then-anchor panel (계획 §1.5 앵커 방식). */

import { useEffect, useState } from "react";

import { useI18n } from "@/components/i18n";
import { searchObjects, searchTablesAi } from "@/lib/api";
import type { ObjectSummary } from "@/lib/types";

interface Props {
  onSelect: (obj: ObjectSummary) => void;
  selectedId: number | null;
}

export function SearchPanel({ onSelect, selectedId }: Props) {
  const { t } = useI18n();
  // 플로팅 오버레이 — 접으면 검색 버튼만 남는다 / floating overlay, folds to a button
  const [open, setOpen] = useState(true);
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

  if (!open) {
    return (
      <button
        className="icon-button absolute left-3 top-3 z-20"
        onClick={() => setOpen(true)}
        title={t("erd.searchOpen")}
        data-testid="SearchPanel-openButton"
      >
        {/* 플랫 돋보기 — 이모지 대신 currentColor SVG / flat magnifier, theme-aware */}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="M15.5 15.5 L20.5 20.5" />
        </svg>
      </button>
    );
  }

  return (
    <aside
      className="absolute left-3 top-3 z-20 flex w-72 flex-col rounded-xl border"
      style={{
        borderColor: "var(--hairline-strong)", background: "var(--surface-card)",
        maxHeight: "calc(100% - 24px)",
      }}
      data-testid="SearchPanel-root"
    >
      <div className="p-3">
        <div className="flex items-center gap-2">
          <input
            className="w-full rounded border px-3 py-2 text-sm outline-none focus:border-[var(--focus-blue)]"
            style={{ borderColor: "var(--border-light)" }}
            placeholder={t("erd.searchPlaceholder")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            data-testid="SearchPanel-queryInput"
          />
          <button className="icon-button shrink-0" onClick={() => setOpen(false)}
                  title={t("erd.searchClose")} data-testid="SearchPanel-foldButton">
            ✕
          </button>
        </div>
        <select
          className="mt-2 w-full rounded border px-2 py-1.5 text-sm"
          style={{ borderColor: "var(--border-light)" }}
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as "" | "table" | "view")}
          data-testid="SearchPanel-typeSelect"
        >
          <option value="">{t("erd.typeAll")}</option>
          <option value="table">{t("erd.typeTable")}</option>
          <option value="view">{t("erd.typeView")}</option>
        </select>
      </div>

      {error && (
        <p className="px-3 text-sm" style={{ color: "var(--error)" }}
           data-testid="SearchPanel-errorText">
          {error}
        </p>
      )}

      <ul className="scroll-area min-h-0 flex-1 overflow-y-auto pb-1"
          data-testid="SearchPanel-resultList">
        {items.map((item) => (
          <li key={item.id}>
            <button
              className="w-full px-3 py-2 text-left text-sm hover:bg-[var(--soft-stone)]"
              style={item.id === selectedId ? { background: "var(--soft-stone)" } : undefined}
              onClick={() => {
                onSelect(item);
                setOpen(false); // 선택 후 캔버스에 집중 / fold after picking an anchor
              }}
              data-testid={`SearchPanel-item-${item.id}`}
            >
              <span className={`obj-chip mr-1.5 ${item.type === "view" ? "obj-chip--view" : ""}`}>
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
            {t("erd.noResults")}
          </li>
        )}
      </ul>
    </aside>
  );
}
