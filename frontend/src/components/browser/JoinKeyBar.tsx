"use client";

/** 상단 조인키 필터 바 — 상위만 노출, 나머지는 접기 / top join keys, rest folded. */

import { useState } from "react";

import type { JoinKeyItem } from "@/lib/api";

// 한눈에 스캔 가능한 칩 수 — 나머지는 +N 뒤로 / chips scannable at a glance
const VISIBLE_KEYS = 12;

interface Props {
  items: JoinKeyItem[];
  selected: JoinKeyItem | null;
  onSelect: (item: JoinKeyItem | null) => void;
}

export function JoinKeyBar({ items, selected, onSelect }: Props) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, VISIBLE_KEYS);
  // 접힌 목록 밖의 선택 키는 항상 보이게 / a hidden selected key stays visible
  const pinned =
    selected && !visible.some((item) => item.key === selected.key) ? [selected] : [];
  const hiddenCount = items.length - VISIBLE_KEYS;

  return (
    <div
      className="flex shrink-0 items-start gap-3 px-5 py-3"
      data-testid="JoinKeyBar-root"
    >
      <span className="erd-node__type mt-1.5 shrink-0">JOIN KEYS</span>
      <div className={`flex items-center gap-1.5 ${expanded ? "flex-wrap" : "scroll-area overflow-x-auto pb-0.5"}`}>
        <button
          className={`pressable key-chip ${selected === null ? "key-chip--selected" : ""}`}
          onClick={() => onSelect(null)}
          data-testid="JoinKeyBar-allChip"
        >
          전체
        </button>
        {[...pinned, ...visible].map((item) => (
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
        {hiddenCount > 0 && (
          <button
            className="pressable key-chip"
            style={{ color: "var(--muted)" }}
            onClick={() => setExpanded((cur) => !cur)}
            data-testid="JoinKeyBar-moreButton"
          >
            {expanded ? "접기" : `+${hiddenCount}`}
          </button>
        )}
      </div>
    </div>
  );
}
