"use client";

/** 검증 대기 관계 큐 — /verify의 진입점(무엇부터 검증할지) + AI 제안 실행.
 * The queue of unconfirmed relations, and the AI suggestion job that fills it. */

import { useCallback, useEffect, useState } from "react";

import { useI18n } from "@/components/i18n";
import { fetchAiJob, fetchPendingRelations, startAiSuggest, type PendingRelation } from "@/lib/api";

interface PendingListProps {
  onPick: (rel: PendingRelation) => void;
  /** 값이 바뀌면 목록을 다시 읽는다 — 확정 직후 큐에서 내려간 것을 반영 */
  refreshToken?: number;
  /** 지금 검증 중인 큐 항목 — 홈 목록과 같은 선택 문법(옐로 좌보더)으로 표시 */
  selectedId?: number | null;
}

/** 컬럼·오브젝트 id가 다 있어야 검증 화면으로 옮길 수 있다 / a pick needs every id resolved. */
function isPickable(rel: PendingRelation): boolean {
  return rel.src_object_id !== null && rel.src_column_id !== null
    && rel.tgt_object_id !== null && rel.tgt_column_id !== null;
}

export function PendingList({ onPick, refreshToken = 0, selectedId = null }: PendingListProps) {
  const { t } = useI18n();
  const [items, setItems] = useState<PendingRelation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiJobId, setAiJobId] = useState<number | null>(null);

  const loadPending = useCallback(() => {
    fetchPendingRelations()
      .then((res) => {
        setItems(res.items);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(loadPending, [loadPending, refreshToken]);

  // AI 제안 잡 폴링 — 완료·실패까지 1.5초 간격 (다른 비동기 작업과 동일한 폴링 관용)
  // poll until done or failed, the same 1.5s polling convention used elsewhere
  useEffect(() => {
    if (aiJobId === null) return;
    const timer = setInterval(() => {
      fetchAiJob(aiJobId)
        .then((job) => {
          if (job.status === "done" && job.result && "suggested" in job.result) {
            setAiNotice(t("erd.aiNotice")
              .replace("{s}", String(job.result.suggested))
              .replace("{n}", String(job.result.created)));
            setAiJobId(null);
            setAiBusy(false);
            loadPending(); // 새로 생긴 제안이 곧바로 큐에 보이게
          } else if (job.status === "failed") {
            setAiNotice(job.error ?? t("ai.failed"));
            setAiJobId(null);
            setAiBusy(false);
          }
        })
        .catch((e: Error) => {
          setAiNotice(e.message);
          setAiJobId(null);
          setAiBusy(false);
        });
    }, 1500);
    return () => clearInterval(timer);
  }, [aiJobId, loadPending, t]);

  return (
    <section className="card flex min-h-0 flex-col p-3" data-testid="PendingList-root">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-widest"
              style={{ color: "var(--muted)" }}>
          {t("verify.pending.title")} ({items.length})
        </span>
        <button
          className="icon-button ml-auto"
          disabled={aiBusy}
          onClick={() => {
            setAiBusy(true);
            setAiNotice(null);
            startAiSuggest()
              .then((res) => setAiJobId(res.job_id))
              .catch((e: Error) => {
                setAiNotice(e.message);
                setAiBusy(false);
              });
          }}
          data-testid="PendingList-aiSuggestButton"
        >
          {aiBusy ? t("ai.working") : t("verify.pending.aiSuggest")}
        </button>
      </div>

      {aiNotice && (
        <p className="mb-1 text-xs" style={{ color: "var(--slate)" }}
           data-testid="PendingList-aiNotice">
          {aiNotice}
        </p>
      )}
      {error && (
        <p className="mb-1 text-xs" style={{ color: "var(--error)" }}
           data-testid="PendingList-errorText">
          {error}
        </p>
      )}

      <ul className="scroll-area min-h-0 flex-1 overflow-y-auto" data-testid="PendingList-items">
        {items.map((rel) => (
          <li key={rel.id}>
            {/* 좌보더는 항상 그린다(투명) — 선택 시에만 칠해 내용이 밀리지 않게 (.list-row 관용) */}
            <button
              className={`w-full rounded border-l-2 px-2 py-1.5 text-left hover:bg-[var(--soft-stone)] disabled:opacity-40 ${
                rel.id === selectedId
                  ? "border-[var(--primary)] bg-[var(--surface-elevated)]"
                  : "border-transparent"
              }`}
              disabled={!isPickable(rel)}
              title={rel.reason ?? undefined}
              onClick={() => onPick(rel)}
              data-testid={`PendingList-item-${rel.id}`}
            >
              <div className="truncate font-mono text-xs">
                {rel.src_object}.{rel.src_column}
              </div>
              <div className="truncate font-mono text-xs" style={{ color: "var(--slate)" }}>
                → {rel.tgt_object}.{rel.tgt_column}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <span className={rel.status === "validated" ? "badge badge--confirmed" : "badge badge--muted"}>
                  {rel.status}
                </span>
                <span className={rel.origin === "ai" ? "badge badge--ai" : "badge badge--muted"}>
                  {rel.origin}
                </span>
                {rel.confidence !== null && (
                  <span className="font-mono text-xs" style={{ color: "var(--muted)" }}>
                    {rel.confidence.toFixed(2)}
                  </span>
                )}
              </div>
            </button>
          </li>
        ))}
        {items.length === 0 && !error && (
          <li className="px-2 py-1.5 text-xs" style={{ color: "var(--muted)" }}
              data-testid="PendingList-emptyState">
            {t("verify.pending.empty")}
          </li>
        )}
      </ul>
    </section>
  );
}
