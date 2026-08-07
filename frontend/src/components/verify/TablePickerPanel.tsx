"use client";

/** /verify 좌측 테이블 선택 패널 — 검색 후 한 쪽(src/tgt)을 고정한다.
 * Search-and-pin table picker for one side of the verification pair. */

import { useEffect, useState } from "react";

import { useI18n } from "@/components/i18n";
import { searchObjects } from "@/lib/api";
import type { ObjectSummary } from "@/lib/types";

interface TablePickerPanelProps {
  side: "src" | "tgt";
  selected: ObjectSummary | null;
  /** null이면 선택 해제 / null clears the selection */
  onSelect: (obj: ObjectSummary | null) => void;
}

export function TablePickerPanel({ side, selected, onSelect }: TablePickerPanelProps) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<ObjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setItems([]);
      return;
    }
    const timer = setTimeout(() => {
      // 뷰는 검증 대상이 아니다 — 페어 후보·containment 모두 base table 기준
      searchObjects(query, "table")
        .then((res) => {
          setItems(res.items);
          setError(null);
        })
        .catch((e: Error) => setError(e.message));
    }, 300); // 타이핑 디바운스 / typing debounce
    return () => clearTimeout(timer);
  }, [q]);

  return (
    <section className="card p-3" data-testid={`TablePickerPanel-root-${side}`}>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-widest"
              style={{ color: "var(--muted)" }}>
          {t(side === "src" ? "verify.srcTitle" : "verify.tgtTitle")}
        </span>
        {selected && (
          <button
            className="icon-button ml-auto"
            onClick={() => onSelect(null)}
            data-testid={`TablePickerPanel-clearButton-${side}`}
          >
            {t("verify.clearSelection")}
          </button>
        )}
      </div>

      {selected ? (
        <p className="font-mono text-sm" style={{ color: "var(--ink)" }}
           data-testid={`TablePickerPanel-selected-${side}`}>
          {selected.schema}.{selected.name}
        </p>
      ) : (
        <>
          <input
            className="w-full rounded border px-3 py-2 text-sm outline-none focus:border-[var(--focus-blue)]"
            style={{ borderColor: "var(--border-light)" }}
            placeholder={t("verify.searchPlaceholder")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            data-testid={`TablePickerPanel-searchInput-${side}`}
          />
          {error && (
            <p className="mt-1 text-xs" style={{ color: "var(--error)" }}
               data-testid={`TablePickerPanel-errorText-${side}`}>
              {error}
            </p>
          )}
          <ul className="scroll-area mt-2 max-h-52 overflow-y-auto"
              data-testid={`TablePickerPanel-resultList-${side}`}>
            {items.map((item) => (
              <li key={item.id}>
                <button
                  className="w-full rounded px-2 py-1.5 text-left font-mono text-xs hover:bg-[var(--soft-stone)]"
                  onClick={() => {
                    onSelect(item);
                    setQ("");
                  }}
                  // 두 패널이 같은 테이블을 동시에 띄울 수 있어 side까지 넣어야 유일해진다
                  data-testid={`TablePickerPanel-item-${side}-${item.id}`}
                >
                  {item.schema}.{item.name}
                  <span className="float-right" style={{ color: "var(--muted)" }}>
                    {item.column_count}c
                  </span>
                </button>
              </li>
            ))}
            {q.trim().length >= 2 && items.length === 0 && !error && (
              <li className="px-2 py-1.5 text-xs" style={{ color: "var(--muted)" }}
                  data-testid={`TablePickerPanel-emptyState-${side}`}>
                {t("erd.noResults")}
              </li>
            )}
          </ul>
        </>
      )}
    </section>
  );
}
