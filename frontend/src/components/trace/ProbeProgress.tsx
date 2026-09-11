"use client";

/** 값 추적 진행 카드 — 상태·계획 스탯·진행 바·현재 대상·경과 시간.
 *  Progress card: status badge, plan stats, bar, current object, elapsed time.
 *  중단은 조건 카드의 찾기 버튼이 겸한다 — 같은 자리에서 시작하고 멈춘다. */

import { useI18n } from "@/components/i18n";
import { ColumnsIcon, DatabaseIcon, ListIcon, SampleIcon, ViewIcon } from "@/components/icons";
import { InfoTip } from "@/components/InfoTip";
import { StepCardHeader } from "@/components/verify/StepCardHeader";
import type { ValueProbeJob, ValueProbeStart } from "@/lib/api";
import type { MessageKey } from "@/lib/i18n";
import { useElapsedSeconds } from "@/lib/use-elapsed";
import { describeSkippedView, shouldKeepPolling, takeSkippedForDisplay } from "@/lib/value-probe";

interface ProbeProgressProps {
  job: ValueProbeJob;
  plan: ValueProbeStart["plan"] | null;
}

const STATUS_KEYS: Record<ValueProbeJob["status"], MessageKey> = {
  queued: "trace.status.queued", running: "trace.status.running", done: "trace.status.done",
  failed: "trace.status.failed", cancelled: "trace.status.cancelled",
};

export function ProbeProgress({ job, plan }: ProbeProgressProps) {
  const { t } = useI18n();
  const active = shouldKeepPolling(job.status);
  const seconds = useElapsedSeconds(active);
  const percent = job.progress.total === 0
    ? 100 : Math.round((job.progress.done / job.progress.total) * 100);
  const badge = job.status === "failed" ? "badge--unresolved"
    : job.status === "done" ? "badge--confirmed" : "badge--muted";
  // 새로고침으로 plan(시작 응답)을 잃어도 잡이 들고 있는 값으로 같은 필을 그린다
  const skipped = plan?.related_views.skipped ?? job.related_view_skipped;
  const included = plan?.related_views.included ?? job.related_schemas.length;
  // ⓘ 말풍선이 끝없이 길어지지 않게 — 앞 10개만 보여주고 나머지는 "외 N개"로 접는다
  const { shown: shownSkipped, rest: restSkipped } = takeSkippedForDisplay(skipped);

  return (
    <section className="card p-4" data-testid="ProbeProgress-root">
      <StepCardHeader no={2} icon={<SampleIcon size={14} />} title={t("trace.progress.title")}
                      desc={t("trace.progress.desc")}>
        <span className={`badge ${badge}`} data-testid="ProbeProgress-status">
          {t(STATUS_KEYS[job.status])}
        </span>
      </StepCardHeader>
      {(plan !== null || job.include_related_views) && (
        <div className="mb-2 flex flex-wrap gap-2" data-testid="ProbeProgress-plan">
          {plan && (
            <>
              <span className="stat-pill" data-testid="ProbeProgress-stat-candidates">
                <ListIcon size={12} /> {t("trace.progress.candidates")} <b>{plan.auto}</b>
              </span>
              <span className="stat-pill" data-testid="ProbeProgress-stat-columns">
                <ColumnsIcon size={12} /> {t("trace.progress.columns")} <b>{plan.columns}</b>
              </span>
              <span className="stat-pill" data-testid="ProbeProgress-stat-heavy">
                <DatabaseIcon size={12} /> {t("trace.progress.heavy")} <b>{plan.heavy}</b>
              </span>
            </>
          )}
          {job.include_related_views && (
            <span className="stat-pill" data-testid="ProbeProgress-stat-related">
              <ViewIcon size={12} /> {t("trace.progress.related")} <b>+{included}</b>
              {skipped.length > 0 && (
                <>
                  <span style={{ color: "var(--muted)" }}>
                    · {t("trace.progress.relatedSkipped")} {skipped.length}
                  </span>
                  <span data-testid="ProbeProgress-relatedSkippedTip">
                    <InfoTip text={t("trace.progress.relatedSkippedTip")}>
                      <ul style={{ margin: 0, paddingLeft: 14 }}>
                        {shownSkipped.map((item) => (
                          <li key={item.qname}>{describeSkippedView(item, t)}</li>
                        ))}
                        {restSkipped > 0 && (
                          <li>{t("trace.progress.relatedMore").replace("{n}", String(restSkipped))}</li>
                        )}
                      </ul>
                    </InfoTip>
                  </span>
                </>
              )}
            </span>
          )}
        </div>
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
