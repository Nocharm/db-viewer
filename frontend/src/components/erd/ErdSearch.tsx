"use client";

/** ERD 맵 좌상단 검색 — 이미 로드된 그래프 노드를 클라이언트에서 랭킹해 픽을 넘긴다(fetch 없음).
 * Top-left map search; ranks already-loaded graph nodes client-side and hands off the pick (no fetch). */

import { useEffect, useRef, useState } from "react";

import { useI18n } from "@/components/i18n";
import { rankSearchResults } from "@/lib/search-rank";
import type { GraphNode } from "@/lib/types";

interface ErdSearchProps {
  nodes: GraphNode[];
  onPick: (nodeId: number) => void;
}

const MAX_RESULTS = 20;

function getLabel(node: GraphNode): string {
  return `${node.schema}.${node.name}`;
}

export function ErdSearch({ nodes, onPick }: ErdSearchProps) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 바깥 클릭으로 닫기 — TablePickerPanel의 콤보박스 패턴과 동일 / close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const results = rankSearchResults(q, nodes, getLabel).slice(0, MAX_RESULTS);
  // 타이핑 중 목록이 줄어들면 이전 activeIndex가 범위를 벗어날 수 있다 — 렌더 시점에 보정
  const activeIdx = results.length === 0 ? -1 : Math.min(activeIndex, results.length - 1);

  const pick = (node: GraphNode) => {
    onPick(node.id);
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
      const node = results[activeIdx];
      if (node) pick(node);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className="absolute left-3 top-3 z-10 w-72">
      <input
        className="w-full rounded border px-3 py-2 text-sm outline-none focus:border-[var(--focus-blue)]"
        style={{ borderColor: "var(--border-light)", background: "var(--surface-card)" }}
        placeholder={t("erd.searchPlaceholder")}
        value={q}
        onFocus={() => {
          // 빈 쿼리로는 열지 않는다 — 그래프 미로딩 상태에서 searchEmpty 문구가 오해를 유발한다
          if (q.trim() === "") return;
          setActiveIndex(0);
          setOpen(true);
        }}
        onChange={(e) => {
          const value = e.target.value;
          setQ(value);
          setActiveIndex(0);
          setOpen(value.trim() !== "");
        }}
        onKeyDown={handleKeyDown}
        data-testid="ErdSearch-input"
      />

      {open && (
        <ul className="scroll-area absolute inset-x-0 top-full z-10 mt-1 max-h-72 overflow-y-auto rounded-lg border py-1"
            style={{ borderColor: "var(--hairline)", background: "var(--surface-card)" }}
            data-testid="ErdSearch-resultList">
          {results.length === 0 ? (
            <li className="px-2 py-1.5 text-xs" style={{ color: "var(--muted)" }}
                data-testid="ErdSearch-emptyState">
              {t("erd.searchEmpty")}
            </li>
          ) : (
            results.map((node, idx) => (
              <li key={node.id}>
                <button
                  className="w-full px-2 py-1.5 text-left font-mono text-xs hover:bg-[var(--soft-stone)]"
                  style={idx === activeIdx ? { background: "var(--soft-stone)" } : undefined}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => pick(node)}
                  data-testid={`ErdSearch-item-${node.id}`}
                >
                  {getLabel(node)}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
