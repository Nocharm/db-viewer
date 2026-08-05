"use client";

/** 컬럼 클릭 → 진행 모달 → 검증 요약 → ERD 이동/돌아가기.
 * Column click runs top-candidate T2 with progress, then a summary modal. */

import { useEffect, useState } from "react";

import { PATTERN_LABELS } from "@/components/ColumnPanel";
import { CloseIcon } from "@/components/icons";
import { useI18n } from "@/components/i18n";
import { fetchCandidates, runContainment } from "@/lib/api";
import type { CandidateItem, ContainmentResponse } from "@/lib/types";

// 자동 검증하는 상위 후보 수 — 상세 탐색은 ERD 패널에서 / auto-checked top candidates
const AUTO_CHECK_TOP = 3;

export interface CheckColumn {
  id: number;
  name: string;
}

interface CheckRow {
  candidate: CandidateItem;
  status: "checked" | "no_data" | "failed";
  result?: ContainmentResponse;
}

interface Progress {
  done: number;
  total: number;
  current: string | null;
}

interface Props {
  column: CheckColumn | null;
  onClose: () => void;
  /** ERD 검증 패널 딥링크로 이동 / continue into the ERD validation panel */
  onOpenErd: (columnId: number, columnName: string) => void;
}

export function ColumnCheckModal({ column, onClose, onOpenErd }: Props) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<"candidates" | "validating" | "done">("candidates");
  const [progress, setProgress] = useState<Progress>({ done: 0, total: 0, current: null });
  const [rows, setRows] = useState<CheckRow[]>([]);
  const [excludedReason, setExcludedReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!column) return;
    let cancelled = false; // 모달 닫힘 후 도착하는 응답 무시 / ignore late responses
    setPhase("candidates");
    setProgress({ done: 0, total: 0, current: null });
    setRows([]);
    setExcludedReason(null);
    setError(null);

    const run = async () => {
      const candidates = await fetchCandidates(column.id);
      if (cancelled) return;
      if (candidates.excluded) {
        setExcludedReason(candidates.excluded.reason);
        setPhase("done");
        return;
      }
      const targets = candidates.candidates.slice(0, AUTO_CHECK_TOP);
      if (targets.length === 0) {
        setPhase("done");
        return;
      }
      setPhase("validating");
      setProgress({ done: 0, total: targets.length, current: null });
      const collected: CheckRow[] = [];
      for (const [index, candidate] of targets.entries()) {
        if (cancelled) return;
        setProgress({
          done: index, total: targets.length,
          current: `${candidate.object}.${candidate.column}`,
        });
        try {
          const result = await runContainment(column.id, candidate.column_id);
          collected.push({ candidate, status: "checked", result });
        } catch (e) {
          // 값 데이터 없음(404)과 그 외 실패를 구분해 표기 / distinguish no-data from failure
          const message = e instanceof Error ? e.message : String(e);
          collected.push({
            candidate,
            status: message.includes("no value data") ? "no_data" : "failed",
          });
        }
        if (cancelled) return;
        setRows([...collected]);
        setProgress({ done: index + 1, total: targets.length, current: null });
      }
      setPhase("done");
    };

    run().catch((e) => {
      if (!cancelled) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("done");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [column]);

  if (!column) return null;
  const running = phase !== "done";
  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    // 바깥 닫기는 mousedown 기준 — click은 mouseup에서 나므로 모달 안에서 누른 채
    // 밖으로 끌어 놓으면 의도치 않게 닫힌다 / close on mousedown, not on mouseup
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
         onMouseDown={running ? undefined : onClose}
    >
      <div
        className="flex max-h-[75vh] w-[34rem] max-w-[92vw] flex-col rounded-xl border p-5"
        style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-card)" }}
        onMouseDown={(e) => e.stopPropagation()}
        data-testid="ColumnCheckModal-root"
      >
        <div className="mb-1 flex items-center gap-2">
          <span className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
            {phase === "done" ? t("check.summaryTitle") : t("check.title")}
          </span>
          <span className="font-mono text-xs" style={{ color: "var(--muted)" }}>
            {column.name}
          </span>
          <button className="icon-button ml-auto" onClick={onClose}
                  data-testid="ColumnCheckModal-closeButton">
            <CloseIcon />
          </button>
        </div>

        {/* 진행 단계 — 오래 걸릴 수 있음을 명시 / progress with a long-run notice */}
        {running && (
          <div className="py-3" data-testid="ColumnCheckModal-progress">
            <p className="mb-2 text-sm" style={{ color: "var(--body-text)" }}>
              {phase === "candidates"
                ? t("check.fetchingCandidates")
                : `${t("check.validating")} (${progress.done}/${progress.total})`}
            </p>
            {phase === "validating" && (
              <>
                <div className="rate-bar mb-2 !w-full">
                  <div className="rate-bar__fill transition-all duration-300 ease-in-out"
                       style={{ width: `${percent}%` }} />
                </div>
                {progress.current && (
                  <p className="font-mono text-xs" style={{ color: "var(--stat-ink)" }}>
                    → {progress.current}
                  </p>
                )}
              </>
            )}
            {phase === "candidates" && <div className="skeleton h-8 w-full" />}
            <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
              {t("check.longRunHint")}
            </p>
          </div>
        )}

        {/* 요약 — 결과 표 / summary table */}
        {phase === "done" && (
          <div className="scroll-area min-h-0 overflow-y-auto py-2"
               data-testid="ColumnCheckModal-summary">
            {error && (
              <p className="text-sm" style={{ color: "var(--error)" }}>{error}</p>
            )}
            {excludedReason && (
              <p className="text-sm" style={{ color: "var(--slate)" }}>
                <span className="badge badge--muted mr-1.5">{t("check.excluded")}</span>
                {excludedReason}
              </p>
            )}
            {!error && !excludedReason && rows.length === 0 && (
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                {t("check.noCandidates")}
              </p>
            )}
            <ul className="space-y-2.5">
              {rows.map(({ candidate, status, result }) => (
                <li key={candidate.column_id} className="text-sm"
                    data-testid={`ColumnCheckModal-row-${candidate.column_id}`}>
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-xs">
                      {candidate.object}.{candidate.column}
                    </span>
                    {status === "checked" && result ? (
                      <>
                        <span className="ml-auto text-xs font-semibold tabular-nums"
                              style={{ color: "var(--stat-ink)" }}>
                          {(result.containment * 100).toFixed(1)}%
                        </span>
                        <span className="badge badge--muted">{result.cardinality}</span>
                      </>
                    ) : (
                      <span className="badge badge--muted ml-auto">
                        {status === "no_data" ? t("check.noData") : t("check.failed")}
                      </span>
                    )}
                  </div>
                  {status === "checked" && result && (
                    <p className="mt-0.5 text-xs" style={{ color: "var(--slate)" }}>
                      {PATTERN_LABELS[result.pattern] ?? result.pattern}
                      {result.orphan_count > 0 && ` · 고아 ${result.orphan_count}`}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}
                  data-testid="ColumnCheckModal-backButton">
            {t("check.back")}
          </button>
          <button
            className="btn-primary"
            disabled={running}
            onClick={() => onOpenErd(column.id, column.name)}
            data-testid="ColumnCheckModal-erdButton"
          >
            {t("check.goErd")}
          </button>
        </div>
      </div>
    </div>
  );
}
