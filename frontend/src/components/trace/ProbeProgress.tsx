"use client";

/** 값 추적 진행 카드 — 상태·진행 바·현재 대상·경과 시간·취소.
 *  Progress card: status badge, bar, current object, elapsed time, cancel. */

import { useI18n } from "@/components/i18n";
import { SampleIcon } from "@/components/icons";
import { StepCardHeader } from "@/components/verify/StepCardHeader";
import type { ValueProbeJob, ValueProbeStart } from "@/lib/api";
import type { MessageKey } from "@/lib/i18n";
import { useElapsedSeconds } from "@/lib/use-elapsed";
import { shouldKeepPolling } from "@/lib/value-probe";

interface ProbeProgressProps {
  job: ValueProbeJob;
  plan: ValueProbeStart["plan"] | null;
  onCancel: () => void;
}

const STATUS_KEYS: Record<ValueProbeJob["status"], MessageKey> = {
  queued: "trace.status.queued", running: "trace.status.running", done: "trace.status.done",
  failed: "trace.status.failed", cancelled: "trace.status.cancelled",
};

export function ProbeProgress({ job, plan, onCancel }: ProbeProgressProps) {
  const { t } = useI18n();
  const active = shouldKeepPolling(job.status);
  const seconds = useElapsedSeconds(active);
  const percent = job.progress.total === 0
    ? 100 : Math.round((job.progress.done / job.progress.total) * 100);
  const badge = job.status === "failed" ? "badge--unresolved"
    : job.status === "done" ? "badge--confirmed" : "badge--muted";

  return (
    <section className="card p-4" data-testid="ProbeProgress-root">
      <StepCardHeader no={2} icon={<SampleIcon size={14} />} title={t("trace.progress.title")}
                      desc={t("trace.progress.desc")} done={job.status === "done"}>
        <span className={`badge ${badge}`} data-testid="ProbeProgress-status">
          {t(STATUS_KEYS[job.status])}
        </span>
        {active && (
          <button type="button" className="btn-secondary" onClick={onCancel}
                  data-testid="ProbeProgress-cancelButton">
            {t("trace.progress.cancel")}
          </button>
        )}
      </StepCardHeader>
      {plan && (
        <p className="mb-2 text-xs" style={{ color: "var(--slate)" }} data-testid="ProbeProgress-plan">
          {t("trace.progress.plan")
            .replace("{auto}", String(plan.auto))
            .replace("{columns}", String(plan.columns))
            .replace("{heavy}", String(plan.heavy))}
        </p>
      )}
      <div className="rate-bar" data-testid="ProbeProgress-bar">
        <div className="rate-bar__fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-xs tabular-nums" style={{ color: "var(--slate)" }}>
        <span>{job.progress.done} / {job.progress.total}</span>
        {active && (
          <span>
            {job.current_qname ? `${t("trace.progress.current")}: ${job.current_qname} · ` : ""}
            {seconds}s
          </span>
        )}
      </div>
      {job.error && (
        <p className="mt-2 text-sm" style={{ color: "var(--error)" }} data-testid="ProbeProgress-error">
          {job.error}
        </p>
      )}
    </section>
  );
}
