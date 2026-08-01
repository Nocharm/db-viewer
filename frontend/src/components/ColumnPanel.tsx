"use client";

/** 컬럼 관계 패널 — 후보 → T2 검증 → 미리보기 → 확정 (계획 §3). / candidate-to-confirm panel. */

import { useEffect, useState } from "react";

import {
  confirmRelation,
  fetchCandidates,
  fetchHistory,
  runContainment,
  runPreview,
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

const PATTERN_LABELS: Record<string, string> = {
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
  const [candidates, setCandidates] = useState<CandidatesResponse | null>(null);
  const [selected, setSelected] = useState<CandidateItem | null>(null);
  const [result, setResult] = useState<ContainmentResponse | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCandidates(null);
    setSelected(null);
    setResult(null);
    setPreview(null);
    setHistory([]);
    setConfirmed(false);
    setError(null);
    if (column) {
      fetchCandidates(column.id).then(setCandidates).catch((e) => setError(e.message));
    }
  }, [column]);

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
      className="flex h-full w-96 flex-col overflow-y-auto border-l p-3"
      style={{ borderColor: "var(--hairline)" }}
      data-testid="ColumnPanel-root"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="erd-node__header flex-1 !border-0 !p-0">
          {column.object}.{column.name}
        </span>
        <button className="icon-button" onClick={onClose} data-testid="ColumnPanel-closeButton">
          ✕
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
                <span className="float-right">{candidate.score}</span>
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
              후보 없음
            </li>
          )}
        </ul>
      )}

      {selected && (
        <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--hairline)" }}>
          <div className="mb-2 flex gap-2">
            <button className="icon-button" disabled={busy}
                    onClick={() => verify(selected)}
                    data-testid="ColumnPanel-verifyButton">
              T2 검증
            </button>
            <button className="icon-button" disabled={busy}
                    onClick={() => run(async () =>
                      setPreview(await runPreview(column.id, selected.column_id)))}
                    data-testid="ColumnPanel-previewButton">
              미리보기 20행
            </button>
            <button className="icon-button" disabled={busy || !result}
                    onClick={() => run(async () => {
                      await confirmRelation(column.id, selected.column_id);
                      setConfirmed(true);
                    })}
                    data-testid="ColumnPanel-confirmButton">
              확정
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
              <div className="text-xs font-medium">검증 이력</div>
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
