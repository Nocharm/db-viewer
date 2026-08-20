"use client";

/** 선택 영역(출발·대상·컬럼 페어)의 접이식 껍데기.
 *
 * 셋 다 고르고 나면 좌측 열에서 할 일이 없어지는데, 카드 세 장이 그대로 자리를 먹으면
 * 그 아래 검증 카드가 화면 밖으로 밀린다. 다 고른 순간 한 줄 요약으로 접고, 헤더를
 * 누르면 다시 펼쳐 수정한다.
 * Collapsible shell for the pick area: it folds to a one-line summary once the pair is
 * complete, and the header re-opens it for edits.
 */

import { useI18n } from "@/components/i18n";
import { CaretDownIcon, CaretRightIcon } from "@/components/icons";
import type { PairCandidate } from "@/lib/api";
import type { ObjectSummary } from "@/lib/types";

interface SelectionPanelProps {
  collapsed: boolean;
  onToggle: () => void;
  src: ObjectSummary | null;
  tgt: ObjectSummary | null;
  pair: PairCandidate | null;
  children: React.ReactNode;
}

function qname(obj: ObjectSummary | null): string {
  return obj ? `${obj.schema}.${obj.name}` : "—";
}

export function SelectionPanel({
  collapsed, onToggle, src, tgt, pair, children,
}: SelectionPanelProps) {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-3" data-testid="SelectionPanel-root">
      <button
        className="pressable card flex items-start gap-2 p-3 text-left"
        onClick={onToggle}
        title={collapsed ? t("verify.summary.expand") : t("verify.summary.collapse")}
        data-testid="SelectionPanel-toggle"
      >
        <span className="mt-0.5 shrink-0" style={{ color: "var(--muted)" }}>
          {collapsed ? <CaretRightIcon size={12} /> : <CaretDownIcon size={12} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold uppercase tracking-widest"
                style={{ color: "var(--muted)" }}>
            {t("verify.summary.title")}
          </span>
          {collapsed && (
            <span className="mt-1 block" data-testid="SelectionPanel-summary">
              <span className="block truncate font-mono text-xs" style={{ color: "var(--ink)" }}>
                {qname(src)}
              </span>
              <span className="block truncate font-mono text-xs" style={{ color: "var(--ink)" }}>
                ↳ {qname(tgt)}
              </span>
              <span className="mt-0.5 block truncate font-mono text-[11px]"
                    style={{ color: "var(--stat-ink)" }}>
                {pair ? `${pair.src_column} = ${pair.tgt_column}` : t("verify.diagram.pickPair")}
              </span>
            </span>
          )}
        </span>
        <span className="shrink-0 text-[11px]" style={{ color: "var(--muted)" }}>
          {collapsed ? t("verify.summary.expand") : t("verify.summary.collapse")}
        </span>
      </button>

      {/* 접힘은 렌더 자체를 걷어낸다 — 피커의 드롭다운·플라이아웃이 숨은 채 살아 있으면
          바깥 클릭 처리가 유령처럼 남는다 / unmount when folded, don't just hide */}
      {!collapsed && children}
    </div>
  );
}
