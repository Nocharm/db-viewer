"use client";

/** 포함률 검증 카드 — 실데이터 관측치를 증상·처방으로 옮겨 보여준다.
 * Containment result rendered as a symptom and a remedy, not raw numbers. */

import { useI18n } from "@/components/i18n";
import { getJoinVerdict, type VerdictLevel } from "@/lib/join-verdict";
import type { ContainmentResponse } from "@/lib/types";

interface ContainmentCardProps {
  result: ContainmentResponse | null;
  busy: boolean;
  /** 게이트를 통과해야 켜진다 — verify-flow.canRunContainment */
  enabled: boolean;
  onRun: () => void;
}

// 판정 색 — 배경은 같은 색 18% 틴트 / verdict colors; backgrounds are an 18% tint
const LEVEL_COLOR: Record<VerdictLevel, string> = {
  safe: "var(--rel-confirmed)",
  caution: "var(--stat-ink)",
  danger: "var(--rel-unresolved)",
  unknown: "var(--muted)",
};

export function ContainmentCard({ result, busy, enabled, onRun }: ContainmentCardProps) {
  const { t } = useI18n();
  const verdict = result ? getJoinVerdict(result, null) : null;
  const color = LEVEL_COLOR[verdict?.level ?? "unknown"];

  return (
    <section className="card p-4" data-testid="ContainmentCard-root">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-widest"
              style={{ color: "var(--muted)" }}>
          {t("verify.containment.title")}
        </span>
        <button
          className="btn-secondary ml-auto !py-1 text-xs"
          disabled={busy || !enabled}
          onClick={onRun}
          data-testid="ContainmentCard-runButton"
        >
          {busy ? t("common.loading") : t("verify.containment.run")}
        </button>
      </div>

      {result && verdict && (
        <>
          <div className="mb-3">
            <span
              className="inline-block rounded-full px-3 py-1 text-xs font-semibold"
              style={{ background: `color-mix(in srgb, ${color} 18%, var(--surface-card))`, color }}
              data-testid="ContainmentCard-verdict"
            >
              {verdict.symptom}
              {verdict.remedy && ` → ${verdict.remedy}`}
            </span>
          </div>
          <div className="flex items-end gap-6">
            <div>
              <div className="text-xs" style={{ color: "var(--muted)" }}>
                {t("join.numbersContainment")}
              </div>
              <div className="text-2xl font-bold tabular-nums" style={{ color }}>
                {(result.containment * 100).toFixed(1)}%
              </div>
            </div>
            <div>
              <div className="text-xs" style={{ color: "var(--muted)" }}>cardinality</div>
              <div className="text-2xl font-bold" style={{ color: "var(--ink)" }}>
                {result.cardinality}
              </div>
            </div>
            <div>
              <div className="text-xs" style={{ color: "var(--muted)" }}>
                {t("join.numbersOrphan")}
              </div>
              <div className="text-2xl font-bold tabular-nums"
                   style={{ color: result.orphan_count > 0 ? "var(--rel-unresolved)" : "var(--ink)" }}>
                {result.orphan_count.toLocaleString()}
              </div>
            </div>
          </div>
          <div className="mt-2 h-2 w-full rounded" style={{ background: "var(--surface-elevated)" }}>
            <div className="h-2 rounded"
                 style={{ width: `${Math.min(result.containment * 100, 100)}%`, background: color }} />
          </div>
          <div className="mt-1 font-mono text-xs" style={{ color: "var(--muted)" }}>
            {result.matched.toLocaleString()} / {result.src_distinct.toLocaleString()} · {result.pattern}
          </div>
        </>
      )}
    </section>
  );
}
