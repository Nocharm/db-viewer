"use client";

/** 상단 조인키 필터 바 — 상위만 노출, 나머지는 접기 / top join keys, rest folded. */

import { useState } from "react";

import { useI18n } from "@/components/i18n";
import { InfoTip } from "@/components/InfoTip";
import type { JoinKeyItem } from "@/lib/api";

// 한눈에 스캔 가능한 칩 수 — 나머지는 +N 뒤로 / chips scannable at a glance
const VISIBLE_KEYS = 12;

interface Props {
  items: JoinKeyItem[];
  selected: JoinKeyItem | null;
  onSelect: (item: JoinKeyItem | null) => void;
}

export function JoinKeyBar({ items, selected, onSelect }: Props) {
  const { t } = useI18n();
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
      <span className="mt-1.5 flex shrink-0 items-center gap-1.5">
        <span className="erd-node__type">JOIN KEYS</span>
        <InfoTip text={t("tip.joinKeys")} align="right" />
      </span>
      {/* 더보기 버튼은 스트립 밖 형제 — 스트립 안에 두면 좁은 화면에서 칩들과 함께
          숨은 가로 스크롤 뒤로 밀려, 나머지 키가 있다는 단서 자체가 사라진다(1440px 실측)
          / the fold toggle lives outside the strip: inside it scrolls out of view with
            the chips, hiding the only cue that more keys exist */}
      <div className="flex min-w-0 flex-1 items-start gap-1.5">
        <div className={`flex items-center gap-1.5 ${expanded ? "flex-wrap" : "scroll-area min-w-0 overflow-x-auto pb-0.5"}`}>
          <button
            className={`pressable key-chip ${selected === null ? "key-chip--selected" : ""}`}
            onClick={() => onSelect(null)}
            data-testid="JoinKeyBar-allChip"
          >
            {t("joinkeys.all")}
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
        </div>
        {hiddenCount > 0 && (
          <button
            className="pressable key-chip shrink-0"
            style={{ color: "var(--muted)" }}
            onClick={() => setExpanded((cur) => !cur)}
            data-testid="JoinKeyBar-moreButton"
          >
            {expanded ? t("joinkeys.fold") : `+${hiddenCount}`}
          </button>
        )}
      </div>
    </div>
  );
}
