"use client";

/** 카탈로그 수집 패널 — 단계·전체 트리거 + 진행 폴링 / collection trigger with stage progress. */

import { useCallback, useEffect, useState } from "react";

import { useI18n } from "@/components/i18n";
import {
  cancelCollectJob,
  fetchCollectJobs,
  triggerCollectCatalog,
  triggerCollectFull,
  triggerCollectViewDeps,
  type CollectJob,
} from "@/lib/api";
import type { MessageKey } from "@/lib/i18n";

// 진행 폴링 간격(ms) — 실행 중일 때만 돈다 / poll only while a job is running
const POLL_MS = 1500;

const STAGE_FLOW: { stage: CollectJob["stage"]; labelKey: MessageKey }[] = [
  { stage: "catalog_running", labelKey: "collect.stageCatalogRunning" },
  { stage: "catalog_done", labelKey: "collect.stageCatalogDone" },
  { stage: "deps_running", labelKey: "collect.stageDepsRunning" },
  { stage: "ready", labelKey: "collect.stageReady" },
];

function isRunning(job: CollectJob | null): boolean {
  return job !== null && (job.stage === "catalog_running" || job.stage === "deps_running");
}

/** 단계 칩 줄 — 지난 단계·현재 단계·남은 단계를 색으로 구분 / stage chips row. */
function StageProgress({ job }: { job: CollectJob }) {
  const { t } = useI18n();
  if (job.stage === "failed") {
    return (
      <p className="text-sm" style={{ color: "var(--error)" }}
         data-testid="CollectPanel-failedText">
        {t("collect.failed")} — {job.error}
      </p>
    );
  }
  const currentIndex = STAGE_FLOW.findIndex((s) => s.stage === job.stage);
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="CollectPanel-stageRow">
      {STAGE_FLOW.map(({ stage, labelKey }, index) => {
        const state = index < currentIndex ? "done"
          : index === currentIndex ? "active" : "pending";
        return (
          <span key={stage} className="flex items-center gap-1.5 text-xs">
            {index > 0 && <span style={{ color: "var(--muted-soft)" }}>→</span>}
            <span
              className={state === "active" && stage !== "ready" ? "skeleton !bg-transparent" : ""}
              style={{
                color: state === "done" ? "var(--rel-confirmed)"
                  : state === "active" ? "var(--stat-ink)" : "var(--muted)",
                fontWeight: state === "active" ? 600 : 400,
              }}
            >
              {state === "done" ? "✓ " : ""}{t(labelKey)}
            </span>
          </span>
        );
      })}
    </div>
  );
}

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

  return (
    <section className="mb-6" data-testid="CollectPanel-root">
      <div className="mb-1 flex items-center gap-3">
        <h2 className="text-sm font-medium">{t("collect.title")}</h2>
      </div>
      <p className="mb-3 text-xs" style={{ color: "var(--muted)" }}>
        {t("collect.hint")}
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          className="btn-primary"
          disabled={busy || running}
          onClick={() => act(triggerCollectCatalog)}
          data-testid="CollectPanel-catalogButton"
        >
          {t("collect.step1")}
        </button>
        <button
          className="btn-secondary"
          disabled={busy || running || current?.stage !== "catalog_done"}
          onClick={() => current && act(() => triggerCollectViewDeps(current.job_id))}
          data-testid="CollectPanel-viewDepsButton"
        >
          {t("collect.step2")}
        </button>
        <button
          className="btn-secondary"
          disabled={busy || running}
          onClick={() => act(triggerCollectFull)}
          data-testid="CollectPanel-fullButton"
        >
          {t("collect.full")}
        </button>
      </div>

      {current && (
        <div className="card mb-3 flex flex-col gap-2 p-4" data-testid="CollectPanel-current">
          <div className="flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
            <span className="font-mono">#{current.job_id}</span>
            <span className="badge badge--muted">{current.mode}</span>
            {current.snapshot_id !== null && (
              <span>{t("collect.snapshot")} #{current.snapshot_id}</span>
            )}
          </div>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1"><StageProgress job={current} /></div>
            {running && (
              <button
                className="icon-button shrink-0"
                title={t("collect.cancelHint")}
                disabled={busy}
                onClick={() => act(() => cancelCollectJob(current.job_id))}
                data-testid="CollectPanel-cancelButton"
              >
                {t("collect.cancel")}
              </button>
            )}
          </div>
          {chunkProgress !== null && chunkProgress.total > 0 && (
            <div data-testid="CollectPanel-chunkProgress">
              <p className="mb-1 text-xs" style={{ color: "var(--body-text)" }}>
                {t("collect.chunkProgress")} ({chunkProgress.done}/{chunkProgress.total})
              </p>
              <div className="rate-bar !w-full">
                <div className="rate-bar__fill transition-all duration-300 ease-in-out"
                     style={{
                       width: `${Math.round((chunkProgress.done / chunkProgress.total) * 100)}%`,
                     }} />
              </div>
            </div>
          )}
          {countText && (
            <p className="font-mono text-xs" style={{ color: "var(--slate)" }}
               data-testid="CollectPanel-counts">
              {countText}
            </p>
          )}
        </div>
      )}

      {jobs.length > 1 && (
        <div data-testid="CollectPanel-recentList">
          <div className="mb-1 text-xs font-medium" style={{ color: "var(--muted)" }}>
            {t("collect.recent")}
          </div>
          <ul className="space-y-1 text-xs" style={{ color: "var(--slate)" }}>
            {jobs.slice(1, 6).map((job) => (
              <li key={job.job_id} className="flex items-center gap-2">
                <span className="font-mono">#{job.job_id}</span>
                <span className="badge badge--muted">{job.mode}</span>
                <span>{job.stage}</span>
                <span style={{ color: "var(--muted)" }}>
                  {new Date(job.updated_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {jobs.length === 0 && !error && (
        <p className="text-sm" style={{ color: "var(--muted)" }}>{t("collect.none")}</p>
      )}
      {error && (
        <p className="text-sm" style={{ color: "var(--error)" }}
           data-testid="CollectPanel-errorText">
          {error}
        </p>
      )}
    </section>
  );
}
