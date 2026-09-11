"use client";

/** 카탈로그 수집 패널 — ①카탈로그 → ②뷰 의존·파싱 → 완료 스테퍼 + 잡 목록 + 진행 폴링.
 * Collection panel: three-step stepper, job rows, progress polling while a job runs. */

import { useCallback, useEffect, useState } from "react";

import { useI18n } from "@/components/i18n";
import {
  CheckIcon,
  PlayIcon,
  StopIcon,
  WarningIcon,
} from "@/components/icons";
import {
  cancelCollectJob,
  fetchCollectJobs,
  triggerCollectCatalog,
  triggerCollectFull,
  triggerCollectViewDeps,
  type CollectJob,
} from "@/lib/api";
import { formatRelativeTime } from "@/lib/relative-time";

// 진행 폴링 간격(ms) — 실행 중일 때만 돈다 / poll only while a job is running
const POLL_MS = 1500;

export type StepState = "done" | "active" | "pending" | "failed";

/** 3단 스테퍼 상태 — 잡 단계에서 ①카탈로그 ②뷰 의존·파싱 ③완료 각각의 상태를 뽑는다.
 * catalog_done은 ①만 끝난 상태(②는 대기) / step states derived from the job stage. */
export function getStepStates(job: CollectJob | null): [StepState, StepState, StepState] {
  if (!job) return ["pending", "pending", "pending"];
  switch (job.stage) {
    case "catalog_running": return ["active", "pending", "pending"];
    case "catalog_done": return ["done", "pending", "pending"];
    case "deps_running": return ["done", "active", "pending"];
    case "ready": return ["done", "done", "done"];
    case "failed": return ["failed", "failed", "pending"];
  }
}

export type JobStatus = "running" | "done" | "failed" | "cancelled" | "step1";

/** 잡 행의 상태 — 중단은 failed 위에 "cancelled by"가 실려 온다 / cancelled rides on failed */
export function getJobStatus(job: CollectJob): JobStatus {
  if (job.stage === "catalog_running" || job.stage === "deps_running") return "running";
  if (job.stage === "ready") return "done";
  if (job.stage === "catalog_done") return "step1";
  return job.error?.startsWith("cancelled by") ? "cancelled" : "failed";
}

function isRunning(job: CollectJob | null): boolean {
  return job !== null && getJobStatus(job) === "running";
}

const STATUS_BADGE: Record<JobStatus, string> = {
  running: "badge--warn", done: "badge--ok", failed: "badge--err",
  cancelled: "badge--muted", step1: "badge--muted",
};

export function CollectPanel() {
  const { t } = useI18n();
  const [jobs, setJobs] = useState<CollectJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = jobs[0] ?? null;
  const running = isRunning(current);

  const reload = useCallback(
    () => fetchCollectJobs().then((r) => setJobs(r.items)).catch((e) => setError(e.message)),
    [],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, reload]);

  const act = (task: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    task()
      .then(() => reload())
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const counts = current?.counts ?? {};
  // 청크 카운터는 진행 바가 담당 — 숫자 나열에서 제외 / chunk counters render as the bar
  const countText = Object.entries(counts)
    .filter(([key]) => !key.endsWith("_chunks_done") && !key.endsWith("_chunks_total"))
    .map(([key, value]) => `${key} ${value.toLocaleString()}`)
    .join(" · ");
  const chunkProgress = current?.stage === "catalog_running"
    ? { done: counts.catalog_chunks_done ?? 0, total: counts.catalog_chunks_total ?? 0 }
    : current?.stage === "deps_running"
      ? { done: counts.deps_chunks_done ?? 0, total: counts.deps_chunks_total ?? 0 }
      : null;
  const chunkText = chunkProgress && chunkProgress.total > 0
    ? `${t("collect.chunkProgress")} ${chunkProgress.done} / ${chunkProgress.total}`
    : "";

  const steps = getStepStates(current);
  const statusLabel: Record<JobStatus, string> = {
    running: t("collect.running"), done: t("collect.stageReady"), failed: t("collect.failed"),
    cancelled: t("collect.cancelled"), step1: t("collect.stageCatalogDone"),
  };
  const stepBadge = (state: StepState) => (
    <span className={`badge badge--plain ${
      state === "done" ? "badge--ok" : state === "active" ? "badge--warn"
        : state === "failed" ? "badge--err" : "badge--muted"}`}>
      {state === "done" ? t("collect.stepDone") : state === "active" ? t("collect.running")
        : state === "failed" ? t("collect.failed") : t("collect.pending")}
    </span>
  );
  const stepNumber = (state: StepState, index: number) => (
    <span className="step__n">{state === "done" ? <CheckIcon size={13} /> : index}</span>
  );
  const snapshotText = current?.snapshot_id !== null && current?.snapshot_id !== undefined
    ? `${t("collect.snapshot")} #${current.snapshot_id}` : "";

  return (
    <section className="mb-6" data-testid="CollectPanel-root">
      <div className="sec-head">
        <span className="sec-head__tile"><PlayIcon size={14} /></span>
        <h2 className="sec-head__title">{t("collect.title")}</h2>
        {current && (
          <span className="cnt-pill" data-testid="CollectPanel-currentId">#{current.job_id}</span>
        )}
      </div>
      <p className="sec-desc">{t("collect.hint")}</p>

      <div className="stepper" data-testid="CollectPanel-stageRow">
        <div className={`card step step--${steps[0]}`} data-testid="CollectPanel-step-1">
          {stepNumber(steps[0], 1)}
          <span className="step__title">{t("collect.step1")}{stepBadge(steps[0])}</span>
          <span className="step__sub">
            {steps[0] === "active" ? chunkText || t("collect.stageCatalogRunning") : countText || " "}
          </span>
        </div>
        <div className={`card step step--${steps[1]}`} data-testid="CollectPanel-step-2">
          {stepNumber(steps[1], 2)}
          <span className="step__title">{t("collect.step2")}{stepBadge(steps[1])}</span>
          <span className="step__sub">
            {steps[1] === "active" ? [chunkText, snapshotText].filter(Boolean).join(" · ") || t("collect.stageDepsRunning")
              : snapshotText || " "}
          </span>
        </div>
        <div className={`card step step--${steps[2]}`} data-testid="CollectPanel-step-3">
          {stepNumber(steps[2], 3)}
          <span className="step__title">{t("collect.stepDone")}{stepBadge(steps[2])}</span>
          <span className="step__sub">{t("collect.stepDoneHint")}</span>
        </div>
      </div>

      {current?.stage === "failed" && (
        <div className="banner banner--err" data-testid="CollectPanel-failedText">
          <WarningIcon size={15} />
          <span>{statusLabel[getJobStatus(current)]} — {current.error}</span>
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          className="btn-secondary inline-flex items-center gap-1.5"
          disabled={busy || running}
          onClick={() => act(triggerCollectCatalog)}
          data-testid="CollectPanel-catalogButton"
        >
          <PlayIcon size={13} />{t("collect.step1Only")}
        </button>
        <button
          className="btn-secondary inline-flex items-center gap-1.5"
          disabled={busy || running || current?.stage !== "catalog_done"}
          onClick={() => current && act(() => triggerCollectViewDeps(current.job_id))}
          data-testid="CollectPanel-viewDepsButton"
        >
          <PlayIcon size={13} />{t("collect.step2Only")}
        </button>
        {/* 전체 실행만 옐로 — 평소 누르는 버튼이 하나뿐이라 위계가 서고, 관리 페이지의 다른 CTA
            (인덱싱·등록)와는 탭이 달라 충돌하지 않는다 / the everyday action gets the yellow */}
        <button
          className="btn-primary inline-flex items-center gap-1.5"
          disabled={busy || running}
          onClick={() => act(triggerCollectFull)}
          data-testid="CollectPanel-fullButton"
        >
          <PlayIcon size={13} />{t("collect.full")}
        </button>
        {running && current && (
          <button
            className="icon-button ctl-field--danger ml-auto"
            title={t("collect.cancelHint")}
            disabled={busy}
            onClick={() => act(() => cancelCollectJob(current.job_id))}
            data-testid="CollectPanel-cancelButton"
          >
            <StopIcon size={13} />{t("collect.cancel")}
          </button>
        )}
      </div>

      {running && chunkProgress !== null && chunkProgress.total > 0 && (
        <div className="mb-3" data-testid="CollectPanel-chunkProgress">
          <div className="rate-bar !w-full">
            <div className="rate-bar__fill transition-all duration-300 ease-in-out"
                 style={{ width: `${Math.round((chunkProgress.done / chunkProgress.total) * 100)}%` }} />
          </div>
        </div>
      )}
      {countText && (
        <p className="mb-3 font-mono text-xs" style={{ color: "var(--slate)" }}
           data-testid="CollectPanel-counts">
          {countText}
        </p>
      )}

      {jobs.length > 0 ? (
        <>
          <div className="sec-head" style={{ marginTop: 6 }}>
            <h3 className="text-xs font-semibold" style={{ color: "var(--muted)" }}>{t("collect.recent")}</h3>
            <span className="cnt-pill">{Math.min(jobs.length, 6)}</span>
          </div>
          <div className="card" data-testid="CollectPanel-recentList">
            {jobs.slice(0, 6).map((job) => {
              const status = getJobStatus(job);
              return (
                <div key={job.job_id} className="job-row" data-testid={`CollectPanel-job-${job.job_id}`}>
                  <span className="job-row__id">#{job.job_id}</span>
                  <span className={`badge badge--plain ${STATUS_BADGE[status]}`}>
                    <span className="badge__dot" />{statusLabel[status]}
                  </span>
                  <span style={{ color: "var(--body-text)" }}>
                    {job.mode}
                    {job.snapshot_id !== null && ` · ${t("collect.snapshot")} #${job.snapshot_id}`}
                    {status === "failed" && job.error && (
                      <span style={{ color: "var(--error)" }}> · {job.error}</span>
                    )}
                  </span>
                  <span className="job-row__who">{job.triggered_by}</span>
                  <span className="job-row__when">{formatRelativeTime(job.updated_at)}</span>
                </div>
              );
            })}
          </div>
        </>
      ) : !error && (
        <p className="text-sm" style={{ color: "var(--muted)" }}>{t("collect.none")}</p>
      )}
      {error && (
        <div className="banner banner--err mt-3" data-testid="CollectPanel-errorText">
          <WarningIcon size={15} /><span>{error}</span>
        </div>
      )}
    </section>
  );
}
