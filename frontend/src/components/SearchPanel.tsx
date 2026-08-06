"use client";

/** 검색 → 앵커 선택 패널 / search-then-anchor panel (계획 §1.5 앵커 방식). */

import { useEffect, useState } from "react";

import { CloseIcon, SearchIcon } from "@/components/icons";
import { useI18n } from "@/components/i18n";
import { searchObjects, searchTablesAi } from "@/lib/api";
import type { ObjectSummary } from "@/lib/types";

interface Props {
  onSelect: (obj: ObjectSummary) => void;
  selectedId: number | null;
}

export function SearchPanel({ onSelect, selectedId }: Props) {
  const { t } = useI18n();
  // 플로팅 오버레이 — 기본은 접힘(캔버스를 가리지 않게), 펴면 검색 버튼 자리에 패널이 뜬다
  // floating overlay: folded by default so the canvas stays clear
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState<"" | "table" | "view">("");
  const [items, setItems] = useState<ObjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  // LLM 미연결 휴리스틱 검색 결과 표시 — 실 판단으로 오독되면 검증이 오염된다
  const [aiMock, setAiMock] = useState(false);

  useEffect(() => {
    if (q.length < 2) {
      setItems([]);
      return;
    }
    const timer = setTimeout(() => {
      // '?'로 시작하면 AI 자연어 탐색 (계획 §5.1-2) / '?' prefix = AI search
      const isAi = q.startsWith("?");
      const request = isAi
        ? searchTablesAi(q.slice(1).trim()).then((res) => {
            setAiMock(res.mock);
            return res.items
              .filter((h) => h.object_id !== null)
              .map((h) => {
                const [schema, name] = h.object.split(".");
                return {
                  id: h.object_id as number, schema, name,
                  type: "table" as const, row_count: null,
                  column_count: 0, dmv_unresolved: false,
                };
              });
          })
        : searchObjects(q, typeFilter || undefined).then((res) => {
            setAiMock(false);
            return res.items;
          });
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
        className="icon-button absolute left-3 top-14 z-20"
        onClick={() => setOpen(true)}
        title={t("erd.searchOpen")}
        data-testid="SearchPanel-openButton"
      >
        <SearchIcon />
      </button>
    );
  }

  return (
    // top-14 = 뷰 표시 토글 바(top-3 + 약 34px) 아래 — 겹치면 토글을 못 누른다
    <aside
      className="absolute left-3 top-14 z-20 flex w-72 flex-col rounded-xl border"
      style={{
        borderColor: "var(--hairline-strong)", background: "var(--surface-card)",
        maxHeight: "calc(100% - 68px)",
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
            <CloseIcon />
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

      {aiMock && items.length > 0 && (
        <p className="px-3 pb-1">
          <span className="badge badge--muted" data-testid="SearchPanel-aiMockBadge">
            {t("ai.mockBadge")}
          </span>
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
