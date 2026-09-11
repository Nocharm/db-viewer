"use client";

/** 값 추적 결과 카드 — 히트가 도착하는 대로 쌓인다. 미리보기 딥링크·뷰 접기·실패 대상.
 *  Results card: hits as they arrive, preview deep links, folded views, failed targets. */

import Link from "next/link";
import { useState } from "react";

import { useI18n } from "@/components/i18n";
import { CodeIcon, ListIcon, TableIcon, ViewIcon } from "@/components/icons";
import { StepCardHeader } from "@/components/verify/StepCardHeader";
import { ViewDefinitionPanel } from "@/components/ViewDefinitionPanel";
import type { ValueProbeJob } from "@/lib/api";
import { buildPreviewHref, formatMatchCount, shouldKeepPolling } from "@/lib/value-probe";

interface ProbeHitsProps {
  job: ValueProbeJob;
  sourceId: number | null;
  canContinue: boolean;
  onContinue: () => void;
}

export function ProbeHits({ job, sourceId, canContinue, onContinue }: ProbeHitsProps) {
  const { t } = useI18n();
  const finished = !shouldKeepPolling(job.status);
  // 히트마다 따로 접었다 편다 — 뷰가 여러 개 맞으면 정의를 나란히 놓고 비교한다
  const [openPanels, setOpenPanels] = useState<Set<string>>(new Set());

  const togglePanel = (key: string) => setOpenPanels((current) => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  });

  return (
    <section className="card p-4" data-testid="ProbeHits-root">
      <StepCardHeader no={3} icon={<ListIcon size={14} />} title={t("trace.hits.title")}
                      desc={t("trace.hits.desc")} />
      {job.hits.length === 0 ? (
        finished ? (
          <div className="flex flex-wrap items-center gap-3 text-sm" style={{ color: "var(--slate)" }}
               data-testid="ProbeHits-emptyState">
            <span>{t("trace.hits.empty")}</span>
            {canContinue && (
              <button type="button" className="btn-secondary" onClick={onContinue}
                      data-testid="ProbeHits-continueButton">
                {t("trace.hits.continue")}
              </button>
            )}
          </div>
        ) : (
          <div className="skeleton h-8 rounded" data-testid="ProbeHits-loading" />
        )
      ) : (
        <ul className="flex flex-col gap-2" data-testid="ProbeHits-list">
          {job.hits.map((hit) => {
            const key = `${hit.qname}.${hit.column}`;
            const count = formatMatchCount(hit);
            return (
              <li key={key} className="list-row flex flex-wrap items-center gap-2 px-2 py-1.5"
                  data-testid={`ProbeHits-hit-${key}`}>
                <span className={`obj-chip inline-flex items-center gap-1${
                  hit.object_type === "view" ? " obj-chip--view" : ""}`}>
                  {hit.object_type === "view" ? <ViewIcon size={11} /> : <TableIcon size={11} />}
                  {t(hit.object_type === "view" ? "trace.hits.view" : "trace.hits.table")}
                </span>
                <span className="font-mono text-sm">{hit.qname}</span>
                <span className="key-chip">{hit.column}</span>
                <span className="badge badge--muted tabular-nums">
                  {count ?? t("trace.hits.confirmed")}
                </span>
                {hit.matched_variant !== job.value && (
                  <span className="text-xs" style={{ color: "var(--muted)" }}>
                    {t("trace.hits.storedAs")} <code>{hit.matched_variant}</code>
                  </span>
                )}
                {/* row-action은 tr:hover에서만 드러난다 — 목록 행(li)의 주 행동은 항상 보여야 한다 */}
                <Link href={buildPreviewHref(hit, sourceId)} className="btn-secondary ml-auto"
                      data-testid={`ProbeHits-preview-${key}`}>
                  {t("trace.hits.openPreview")}
                </Link>
                {hit.object_type === "view" && (
                  <button type="button"
                          className="btn-secondary inline-flex items-center gap-1.5"
                          aria-expanded={openPanels.has(key)}
                          onClick={() => togglePanel(key)}
                          data-testid={`ProbeHits-definition-${key}`}>
                    <CodeIcon size={12} />
                    {t("viewdef.button")}
                  </button>
                )}
                {hit.object_type === "view" && openPanels.has(key) && (
                  <div className="w-full" data-testid={`ProbeHits-definitionPanel-${key}`}>
                    <ViewDefinitionPanel objectId={hit.object_id} qname={hit.qname}
                                         highlightColumn={hit.column}
                                         onClose={() => togglePanel(key)} />
                  </div>
                )}
                {hit.exposed_by_views.length > 0 && (
                  <details className="collapsible w-full text-xs">
                    <summary>{t("trace.hits.exposedBy")} {hit.exposed_by_views.length}</summary>
                    <ul className="mt-1 flex flex-col gap-0.5 pl-3">
                      {hit.exposed_by_views.map((view) => (
                        <li key={view} className="font-mono">{view}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {hit.derived_from && (
                  <span className="w-full text-xs" style={{ color: "var(--muted)" }}>
                    {t("trace.hits.derivedFrom")}: <code>{hit.derived_from.qname}.{hit.derived_from.column}</code>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {job.failed_targets.length > 0 && (
        <details className="collapsible mt-3 text-xs" data-testid="ProbeHits-failed">
          <summary>{t("trace.hits.failed")} {job.failed_targets.length}</summary>
          <ul className="mt-1 flex flex-col gap-0.5 pl-3">
            {job.failed_targets.map((target) => (
              <li key={target.qname} className="font-mono">
                {target.qname} — {target.status}{target.error ? ` (${target.error})` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
