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
  /** 좌측 진행 순서가 스크롤해 오는 앵커 / anchor for the side navigator */
  id?: string;
  job: ValueProbeJob;
  busy: boolean;
  onRun: (targetIds: number[]) => void;
}

const REASON_KEYS: Record<ValueProbeHeavy["reason"], MessageKey> = {
  rows: "trace.heavy.reason.rows",
  unknown_rows: "trace.heavy.reason.unknown_rows",
  view_shape: "trace.heavy.reason.view_shape",
};

// 사유마다 색을 달리 준다 — 행 수 초과(주의)·미상(중립)·뷰 모양(추론)이 한눈에 갈린다
const REASON_BADGES: Record<ValueProbeHeavy["reason"], string> = {
  rows: "badge--unresolved",
  unknown_rows: "badge--muted",
  view_shape: "badge--ai",
};

export function ProbeHeavyList({ id, job, busy, onRun }: ProbeHeavyListProps) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<Set<number>>(new Set());

  const toggle = (targetId: number) => setPicked((cur) => {
    const next = new Set(cur);
    if (next.has(targetId)) next.delete(targetId);
    else next.add(targetId);
    return next;
  });

  return (
    <section id={id} className="card p-4" data-testid="ProbeHeavyList-root">
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
            <input type="checkbox" className="ctl-check" checked={picked.has(target.target_id)}
                   onChange={() => toggle(target.target_id)}
                   data-testid={`ProbeHeavyList-item-${target.target_id}`} />
            <span className="font-mono">{target.qname}</span>
            <span className={`badge ${REASON_BADGES[target.reason]}`}>
              {t(REASON_KEYS[target.reason])}
            </span>
            {target.est_rows !== null && (
              <span className="text-xs tabular-nums" style={{ color: "var(--muted)" }}>
                {target.est_rows.toLocaleString()} {t("trace.heavy.rows")}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
