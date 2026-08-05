"use client";

/** 컬럼 관계 패널 — 후보 → T2 검증 → 미리보기 → 확정 (계획 §3). / candidate-to-confirm panel. */

import { useEffect, useState } from "react";

import { CloseIcon } from "@/components/icons";
import { useI18n } from "@/components/i18n";
import {
  confirmRelation,
  explainValidationAi,
  fetchCandidates,
  fetchHistory,
  fetchScanJob,
  runContainment,
  runPreview,
  startScan,
  type ScanJobStatus,
} from "@/lib/api";
import type {
  CandidateItem,
  CandidatesResponse,
  ContainmentResponse,
  HistoryItem,
  PreviewResponse,
} from "@/lib/types";

export interface SelectedColumn {
  id: number;
  name: string;
  object: string;
}

interface Props {
  column: SelectedColumn | null;
  onClose: () => void;
}

export const PATTERN_LABELS: Record<string, string> = {
  stable_confirmed: "지속 1.0 — 사실상 확정 FK",
  stable_with_orphans: "관계 유효 · 고아 데이터 존재",
  drop_alert: "⚠ 급락 — 스키마·데이터 변경 의심",
  small_sample_only: "소량 데이터 — 우연 가능",
  unstable: "불안정",
};

const SIGNAL_LABELS: Record<string, string> = {
  view_join: "뷰 JOIN", naming: "명명", key: "PK",
};

export function ColumnPanel({ column, onClose }: Props) {
  const { t } = useI18n();
  const [candidates, setCandidates] = useState<CandidatesResponse | null>(null);
  const [selected, setSelected] = useState<CandidateItem | null>(null);
  const [result, setResult] = useState<ContainmentResponse | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiText, setAiText] = useState<string | null>(null);
  // LLM 미연결 휴리스틱 설명 표시 — 실 판단으로 오독되면 검증이 오염된다
  const [aiMock, setAiMock] = useState(false);
  // T3 전수 탐색 — 202 + 폴링 진행도 / exploratory scan job with polled progress
  const [scanJob, setScanJob] = useState<ScanJobStatus | null>(null);
  const [scanRunning, setScanRunning] = useState(false);

  useEffect(() => {
    setCandidates(null);
    setSelected(null);
    setResult(null);
    setPreview(null);
    setHistory([]);
    setConfirmed(false);
    setError(null);
    setAiText(null);
    setScanJob(null);
    setScanRunning(false);
    if (column) {
      fetchCandidates(column.id).then(setCandidates).catch((e) => setError(e.message));
    }
  }, [column]);

  // 스캔 폴링 — 완료·실패까지 1.5초 간격 / poll until done or failed
  useEffect(() => {
    if (!scanRunning || !scanJob) return;
    const timer = setInterval(() => {
      fetchScanJob(scanJob.job_id)
        .then((job) => {
          setScanJob(job);
          if (job.status === "done" || job.status === "failed") setScanRunning(false);
        })
        .catch((e) => {
          setError(e.message);
          setScanRunning(false);
        });
    }, 1500);
    return () => clearInterval(timer);
  }, [scanRunning, scanJob]);

  if (!column) return null;

  const run = (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    task().catch((e) => setError(e.message)).finally(() => setBusy(false));
  };

  const verify = (candidate: CandidateItem) =>
    run(async () => {
      const res = await runContainment(column.id, candidate.column_id);
      setResult(res);
      setHistory((await fetchHistory(column.id, candidate.column_id)).items);
    });

  return (
    <aside
      className="scroll-area absolute right-3 top-14 z-20 flex w-96 flex-col overflow-y-auto rounded-xl border p-3"
      style={{
        borderColor: "var(--hairline-strong)", background: "var(--surface-card)",
        maxHeight: "calc(100% - 68px)",
      }}
      data-testid="ColumnPanel-root"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="erd-node__header flex-1 !border-0 !p-0">
          {column.object}.{column.name}
        </span>
        <button className="icon-button" onClick={onClose} data-testid="ColumnPanel-closeButton">
          <CloseIcon />
        </button>
      </div>

      {error && (
        <p className="mb-2 text-sm" style={{ color: "var(--error)" }}
           data-testid="ColumnPanel-errorText">
          {error}
        </p>
      )}

      {candidates?.excluded && (
        <p className="text-sm" data-testid="ColumnPanel-excludedBadge">
          <span className="badge badge--muted">저카디널리티</span>{" "}
          <span style={{ color: "var(--slate)" }}>
            검증 제외 — 사유: {candidates.excluded.reason}
          </span>
        </p>
      )}

      {candidates && !candidates.excluded && (
        <ul data-testid="ColumnPanel-candidateList">
          {candidates.candidates.map((candidate) => (
            <li key={candidate.column_id}>
              <button
                className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--soft-stone)]"
                style={selected?.column_id === candidate.column_id
                  ? { background: "var(--soft-stone)" } : undefined}
                onClick={() => {
                  setSelected(candidate);
                  setResult(null);
                  setPreview(null);
                  setConfirmed(false);
                  fetchHistory(column.id, candidate.column_id)
                    .then((h) => setHistory(h.items));
                }}
                data-testid={`ColumnPanel-candidateItem-${candidate.column_id}`}
              >
                <span className="font-mono text-xs">
                  {candidate.object}.{candidate.column}
                </span>
                {/* 점수는 우측 옐로 볼드 — 스캔 축 / score column scannable in yellow */}
                <span className="float-right text-xs font-semibold tabular-nums"
                      style={{ color: "var(--stat-ink)" }}>
                  {candidate.score}
                </span>
                <div className="mt-0.5 flex gap-1">
                  {Object.keys(candidate.signals).map((signal) => (
                    <span key={signal} className="badge badge--muted">
                      {SIGNAL_LABELS[signal] ?? signal}
                    </span>
                  ))}
                </div>
              </button>
            </li>
          ))}
          {candidates.candidates.length === 0 && (
            <li className="px-2 py-1 text-sm" style={{ color: "var(--muted)" }}>
              {t("panel.noCandidates")}
            </li>
          )}
        </ul>
      )}

      {/* T3 전수 탐색 — 이름 무관 전수조사, 진행도 폴링 / full scan with polled progress */}
      {candidates && !candidates.excluded && (
        <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--hairline)" }}
             data-testid="ColumnPanel-scanSection">
          <div className="flex items-center gap-2">
            <button
              className="btn-secondary !py-1 text-xs"
              disabled={scanRunning}
              onClick={() => {
                setError(null);
                setScanJob(null);
                startScan(column.id)
                  .then((res) => {
                    setScanJob({ job_id: res.job_id, status: "queued",
                                 progress: { done: 0, total: 0 }, error: null, results: [] });
                    setScanRunning(true);
                  })
                  .catch((e) => setError(e.message));
              }}
              data-testid="ColumnPanel-scanButton"
            >
              {t("scan.button")}
            </button>
            <span className="text-xs" style={{ color: "var(--muted)" }}>
              {t("scan.hint")}
            </span>
          </div>

          {scanJob && scanRunning && (
            <div className="mt-2" data-testid="ColumnPanel-scanProgress">
              <p className="mb-1 text-xs" style={{ color: "var(--body-text)" }}>
                {scanJob.status === "queued"
                  ? t("scan.queued")
                  : `${t("scan.running")} (${scanJob.progress.done}/${scanJob.progress.total})`}
              </p>
              <div className="rate-bar !w-full">
                <div className="rate-bar__fill transition-all duration-300 ease-in-out"
                     style={{
                       width: scanJob.progress.total > 0
                         ? `${Math.round((scanJob.progress.done / scanJob.progress.total) * 100)}%`
                         : "6%",
                     }} />
              </div>
            </div>
          )}

          {scanJob && !scanRunning && scanJob.status === "failed" && (
            <p className="mt-2 text-xs" style={{ color: "var(--error)" }}
               data-testid="ColumnPanel-scanError">
              {t("scan.failed")} — {scanJob.error}
            </p>
          )}

          {scanJob && !scanRunning && scanJob.status === "done" && (
            <div className="mt-2" data-testid="ColumnPanel-scanResults">
              <div className="text-xs font-medium">{t("scan.results")}</div>
              {scanJob.results.length === 0 && (
                <p className="text-xs" style={{ color: "var(--muted)" }}>{t("scan.none")}</p>
              )}
              {scanJob.results.map((hit) => (
                <div key={`${hit.tgt_object}.${hit.tgt_column}`}
                     className="flex items-center gap-2 py-0.5 text-xs">
                  <span className="truncate font-mono">
                    {hit.tgt_object}.{hit.tgt_column}
                  </span>
                  <span className="ml-auto font-semibold tabular-nums"
                        style={{ color: "var(--stat-ink)" }}>
                    {((hit.containment_full ?? hit.containment_sample) * 100).toFixed(1)}%
                  </span>
                  {hit.cardinality && (
                    <span className="badge badge--muted">{hit.cardinality}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {selected && (
        <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--hairline)" }}>
          {/* 주 행동은 하나 — T2 검증만 옐로 / one primary action per view */}
          <div className="mb-2 flex items-center gap-2">
            <button className="btn-primary" disabled={busy}
                    onClick={() => verify(selected)}
                    data-testid="ColumnPanel-verifyButton">
              {t("panel.verify")}
            </button>
            <button className="btn-secondary" disabled={busy}
                    onClick={() => run(async () =>
                      setPreview(await runPreview(column.id, selected.column_id)))}
                    data-testid="ColumnPanel-previewButton">
              {t("panel.preview20")}
            </button>
            <button className="btn-secondary" disabled={busy || !result}
                    onClick={() => run(async () => {
                      await confirmRelation(column.id, selected.column_id);
                      setConfirmed(true);
                    })}
                    data-testid="ColumnPanel-confirmButton">
              {t("panel.confirm")}
            </button>
            {confirmed && (
              <span className="badge badge--confirmed" data-testid="ColumnPanel-confirmedBadge">
                ✓ CONFIRMED
              </span>
            )}
          </div>

          {result && (
            <div className="text-sm" data-testid="ColumnPanel-resultBox">
              <div>
                containment <b>{(result.containment * 100).toFixed(2)}%</b>
                {" · "}
                {result.cardinality === "N:M"
                  ? <span className="badge badge--muted">N:M 교차</span>
                  : result.cardinality}
                {" · "}고아 {result.orphan_count}
              </div>
              <div style={{ color: "var(--slate)" }}>
                confidence {result.confidence ?? "—"} · 관측 {result.observations}회 ·{" "}
                {PATTERN_LABELS[result.pattern] ?? result.pattern}
              </div>
              <div className="text-xs" style={{ color: "var(--muted)" }}>
                last verified {new Date(result.observed_at).toLocaleString()}
              </div>
              <button
                className="icon-button mt-1.5"
                disabled={busy}
                onClick={() => selected && run(async () => {
                  const res = await explainValidationAi(column.id, selected.column_id);
                  setAiText(res.explanation);
                  setAiMock(res.mock);
                })}
                data-testid="ColumnPanel-aiExplainButton"
              >
                {t("ai.explainValidation")}
              </button>
              {aiText && (
                <p className="mt-1.5 text-xs leading-relaxed" style={{ color: "var(--slate)" }}
                   data-testid="ColumnPanel-aiExplanation">
                  <span className="badge badge--ai mr-1">AI</span>
                  {aiMock && (
                    <span className="badge badge--muted mr-1"
                          data-testid="ColumnPanel-aiMockBadge">
                      {t("ai.mockBadge")}
                    </span>
                  )}
                  {aiText}
                </p>
              )}
            </div>
          )}

          {preview && (
            <div className="mt-2 overflow-x-auto" data-testid="ColumnPanel-previewTable">
              {preview.masked_columns.length > 0 && (
                <span className="badge badge--muted">마스킹 적용</span>
              )}
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left" style={{ color: "var(--muted)" }}>
                    {Object.keys(preview.rows[0] ?? {}).map((k) => <th key={k}>{k}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, i) => (
                    <tr key={i}>
                      {Object.values(row).map((v, j) => <td key={j}>{String(v)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {history.length > 0 && (
            <div className="mt-3" data-testid="ColumnPanel-historyList">
              <div className="text-xs font-medium">{t("panel.history")}</div>
              {history.map((h, i) => (
                <div key={i} className="text-xs" style={{ color: "var(--slate)" }}>
                  {new Date(h.observed_at).toLocaleString()} —{" "}
                  {(h.containment * 100).toFixed(2)}% ({h.triggered_by})
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
