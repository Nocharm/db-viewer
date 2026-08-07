"use client";

/** /verify 좌측 테이블 선택 패널 — 검색 콤보박스로 한 쪽(src/tgt)을 고정한다.
 * Search combobox that pins one side (src/tgt) of the verification pair. */

import { useEffect, useRef, useState } from "react";

import { useI18n } from "@/components/i18n";
import { CloseIcon } from "@/components/icons";
import { fetchAllObjects } from "@/lib/api";
import { rankSearchResults } from "@/lib/search-rank";
import type { ObjectSummary } from "@/lib/types";

interface TablePickerPanelProps {
  side: "src" | "tgt";
  selected: ObjectSummary | null;
  /** null이면 선택 해제 / null clears the selection */
  onSelect: (obj: ObjectSummary | null) => void;
}

const MAX_RESULTS = 30;

// 카탈로그 전체(테이블만 2천여 개)는 세션 내내 바뀌지 않는다 — 모듈 단위로 캐시해
// src/tgt 두 패널이 동시에 마운트돼도 fetchAllObjects()가 한 번만 돈다.
// / the full catalog never changes mid-session; cache it once so the src/tgt
//   panels — both mounted on the page at once — don't each pay for their own fetch.
let cachedTables: ObjectSummary[] | null = null;
let inFlight: Promise<ObjectSummary[]> | null = null;

function loadTables(): Promise<ObjectSummary[]> {
  if (cachedTables) return Promise.resolve(cachedTables);
  inFlight ??= fetchAllObjects()
    .then((res) => {
      cachedTables = res.items.filter((o) => o.type === "table");
      return cachedTables;
    })
    .catch((e: Error) => {
      inFlight = null; // 실패는 캐시하지 않는다 — 다음 마운트에서 재시도
      throw e;
    });
  return inFlight;
}

function getLabel(obj: ObjectSummary): string {
  return `${obj.schema}.${obj.name}`;
}

export function TablePickerPanel({ side, selected, onSelect }: TablePickerPanelProps) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [tables, setTables] = useState<ObjectSummary[]>(() => cachedTables ?? []);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (cachedTables) return;
    loadTables().then(setTables).catch((e: Error) => setError(e.message));
  }, []);

  // 바깥 클릭으로 닫기 — AppHeader.UserMenu와 동일 패턴 / close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const results = rankSearchResults(q, tables, getLabel).slice(0, MAX_RESULTS);
  // 타이핑 중 목록이 줄어들면 이전 activeIndex가 범위를 벗어날 수 있다 — 렌더 시점에 보정
  const activeIdx = results.length === 0 ? -1 : Math.min(activeIndex, results.length - 1);

  const pick = (item: ObjectSummary) => {
    onSelect(item);
    setQ("");
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex(Math.min(activeIdx + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(Math.max(activeIdx - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = results[activeIdx];
      if (item) pick(item);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <section className="card p-3" data-testid={`TablePickerPanel-root-${side}`}>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-widest"
              style={{ color: "var(--muted)" }}>
          {t(side === "src" ? "verify.srcTitle" : "verify.tgtTitle")}
        </span>
      </div>

      <div ref={rootRef} className="relative">
        <div className="flex items-center gap-1">
          <input
            className="w-full rounded border px-3 py-2 text-sm outline-none focus:border-[var(--focus-blue)]"
            style={{ borderColor: "var(--border-light)" }}
            placeholder={t("verify.searchPlaceholder")}
            value={selected ? getLabel(selected) : q}
            readOnly={!!selected}
            onFocus={() => {
              if (selected) return;
              setActiveIndex(0);
              setOpen(true);
            }}
            onChange={(e) => {
              setQ(e.target.value);
              setActiveIndex(0);
              setOpen(true);
            }}
            onKeyDown={handleKeyDown}
            data-testid={`TablePickerPanel-searchInput-${side}`}
          />
          {selected && (
            <button
              className="icon-button"
              onClick={() => onSelect(null)}
              title={t("verify.clearSelection")}
              data-testid={`TablePickerPanel-clearButton-${side}`}
            >
              <CloseIcon />
            </button>
          )}
        </div>

        {open && !selected && (
          <ul className="scroll-area absolute inset-x-0 top-full z-50 mt-1 max-h-52 overflow-y-auto rounded-lg border py-1"
              style={{ borderColor: "var(--hairline)", background: "var(--surface-card)" }}
              data-testid={`TablePickerPanel-resultList-${side}`}>
            {tables.length === 0 && !error ? (
              <li className="px-2 py-1.5 text-xs" style={{ color: "var(--muted)" }}>
                {t("common.loading")}
              </li>
            ) : results.length === 0 ? (
              <li className="px-2 py-1.5 text-xs" style={{ color: "var(--muted)" }}
                  data-testid={`TablePickerPanel-emptyState-${side}`}>
                {t("erd.noResults")}
              </li>
            ) : (
              results.map((item, idx) => (
                <li key={item.id}>
                  <button
                    className="w-full px-2 py-1.5 text-left font-mono text-xs hover:bg-[var(--soft-stone)]"
                    style={idx === activeIdx ? { background: "var(--soft-stone)" } : undefined}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => pick(item)}
                    // 두 패널이 같은 테이블을 동시에 띄울 수 있어 side까지 넣어야 유일해진다
                    data-testid={`TablePickerPanel-item-${side}-${item.id}`}
                  >
                    {getLabel(item)}
                    <span className="float-right" style={{ color: "var(--muted)" }}>
                      {item.column_count}c
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </div>

      {error && (
        <p className="mt-1 text-xs" style={{ color: "var(--error)" }}
           data-testid={`TablePickerPanel-errorText-${side}`}>
          {error}
        </p>
      )}
    </section>
  );
}
