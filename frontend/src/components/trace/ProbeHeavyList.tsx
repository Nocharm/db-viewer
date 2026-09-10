"use client";

/** 무거운 객체 카드 — 자동 실행에서 뺀 대상을 골라서 실행한다(선택이 곧 비용 승인).
 *  Heavy objects: deferred targets the user explicitly chooses to run. */

import { useState } from "react";

import { useI18n } from "@/components/i18n";
import { DatabaseIcon } from "@/components/icons";
import { StepCardHeader } from "@/components/verify/StepCardHeader";
import type { ValueProbeHeavy, ValueProbeJob } from "@/lib/api";
import type { MessageKey } from "@/lib/i18n";

interface ProbeHeavyListProps {
  job: ValueProbeJob;
  busy: boolean;
  onRun: (targetIds: number[]) => void;
}

const REASON_KEYS: Record<ValueProbeHeavy["reason"], MessageKey> = {
  rows: "trace.heavy.reason.rows",
  unknown_rows: "trace.heavy.reason.unknown_rows",
  view_shape: "trace.heavy.reason.view_shape",
};

export function ProbeHeavyList({ job, busy, onRun }: ProbeHeavyListProps) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<Set<number>>(new Set());

  const toggle = (targetId: number) => setPicked((cur) => {
    const next = new Set(cur);
    if (next.has(targetId)) next.delete(targetId);
    else next.add(targetId);
    return next;
  });

  return (
    <section className="card p-4" data-testid="ProbeHeavyList-root">
      <StepCardHeader no={4} icon={<DatabaseIcon size={14} />} title={t("trace.heavy.title")}
                      desc={t("trace.heavy.desc")}>
        <span className="hint-pill" data-testid="ProbeHeavyList-skippedHint">
          {t("trace.heavy.skipped").replace("{n}", String(job.heavy.length))}
        </span>
        <button type="button" className="btn-primary" disabled={busy || picked.size === 0}
                onClick={() => { onRun([...picked]); setPicked(new Set()); }}
                data-testid="ProbeHeavyList-runButton">
          {t("trace.heavy.run")}
        </button>
      </StepCardHeader>
      <ul className="flex flex-col gap-1">
        {job.heavy.map((target) => (
          <li key={target.target_id} className="list-row flex items-center gap-2 px-2 py-1 text-sm">
            <input type="checkbox" checked={picked.has(target.target_id)}
                   onChange={() => toggle(target.target_id)}
                   data-testid={`ProbeHeavyList-item-${target.target_id}`} />
            <span className="font-mono">{target.qname}</span>
            <span className="text-xs" style={{ color: "var(--muted)" }}>
              {t(REASON_KEYS[target.reason])}
              {target.est_rows !== null ? ` · ${target.est_rows.toLocaleString()} ${t("trace.heavy.rows")}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
