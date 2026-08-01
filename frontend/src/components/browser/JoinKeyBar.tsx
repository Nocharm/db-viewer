"use client";

/** 상단 조인키 필터 바 / join-key filter chips across the top. */

import type { JoinKeyItem } from "@/lib/api";

interface Props {
  items: JoinKeyItem[];
  selected: JoinKeyItem | null;
  onSelect: (item: JoinKeyItem | null) => void;
}

export function JoinKeyBar({ items, selected, onSelect }: Props) {
  return (
    <div
      className="flex shrink-0 items-center gap-3 border-b px-5 py-3"
      style={{ borderColor: "var(--hairline)" }}
      data-testid="JoinKeyBar-root"
    >
      <span className="erd-node__type shrink-0">JOIN KEYS</span>
      <div className="scroll-area flex items-center gap-1.5 overflow-x-auto pb-0.5">
        <button
          className={`pressable key-chip ${selected === null ? "key-chip--selected" : ""}`}
          onClick={() => onSelect(null)}
          data-testid="JoinKeyBar-allChip"
        >
          전체
        </button>
        {items.map((item) => (
          <button
            key={item.key}
            className={`pressable key-chip ${selected?.key === item.key ? "key-chip--selected" : ""}`}
            onClick={() => onSelect(selected?.key === item.key ? null : item)}
            title={`${item.table_count}개 테이블 · 근거 ${item.usage}건`}
            data-testid={`JoinKeyBar-chip-${item.key}`}
          >
            {item.key}
            <span className="key-chip__count">{item.table_count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
