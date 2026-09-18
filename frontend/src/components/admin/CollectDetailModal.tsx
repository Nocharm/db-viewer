"use client";

/** 수집 잡 상세 — 패널은 핵심 숫자 몇 개만 보여주고, 전체 집계는 여기서 단계별 표로 본다.
 * AuditDetailModal과 같은 문법(Esc·배경 클릭·×) / full counts of one collect job, grouped by step. */

import { useEffect, useRef } from "react";

import { useI18n } from "@/components/i18n";
import { CloseIcon } from "@/components/icons";
import type { CollectJob } from "@/lib/api";
import { groupCounts, type CountGroup } from "@/lib/collect-counts";
import { MESSAGES, type MessageKey } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relative-time";

const GROUP_LABEL: Record<CountGroup, MessageKey> = {
  catalog: "collect.groupCatalog", deps: "collect.groupDeps",
  parse: "collect.groupParse", other: "collect.groupOther",
};

/** 집계 키의 표시 이름 — 사전에 없는 새 키는 원문 그대로 / unknown keys show raw */
export function getCountLabel(key: string, t: (key: MessageKey) => string): string {
  const candidate = `collect.count.${key}`;
  return candidate in MESSAGES ? t(candidate as MessageKey) : key;
}

interface CollectDetailModalProps {
  job: CollectJob | null;
  /** 패널이 쓰는 상태 라벨·pill 클래스를 그대로 받는다 — 표기가 두 곳에서 갈리지 않게 */
  statusLabel: string;
  badgeClass: string;
  onClose: () => void;
}

export function CollectDetailModal({ job, statusLabel, badgeClass, onClose }: CollectDetailModalProps) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!job) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [job, onClose]);

  if (!job) return null;
  const groups = groupCounts(job.counts);

  return (
    <div className="modal-backdrop" onClick={onClose} data-testid="CollectDetailModal-root">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="collect-detail-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <span className={`badge badge--plain ${badgeClass}`}>
            <span className="badge__dot" />{statusLabel}
          </span>
          <h3 id="collect-detail-title" className="modal__title">
            {t("collect.detailTitle").replace("{id}", String(job.job_id))}
          </h3>
          <button
            ref={closeRef}
            className="icon-button modal__close"
            onClick={onClose}
            aria-label={t("common.close")}
            data-testid="CollectDetailModal-closeButton"
          >
            <CloseIcon size={13} />
          </button>
        </div>

        <div className="modal__grid">
          <span className="modal__key">{t("collect.fMode")}</span>
          <span><code>{job.mode}</code></span>
          <span className="modal__key">{t("collect.fStage")}</span>
          <span><code>{job.stage}</code></span>
          <span className="modal__key">{t("collect.fSnapshot")}</span>
          <span className="font-mono">{job.snapshot_id !== null ? `#${job.snapshot_id}` : "—"}</span>
          <span className="modal__key">{t("collect.fBy")}</span>
          <span className="font-mono">{job.triggered_by}</span>
          <span className="modal__key">{t("collect.fStarted")}</span>
          <span>{new Date(job.created_at).toLocaleString()}</span>
          <span className="modal__key">{t("collect.fUpdated")}</span>
          <span>
            {new Date(job.updated_at).toLocaleString()}
            <span style={{ color: "var(--muted)" }}> · {formatRelativeTime(job.updated_at)}</span>
          </span>
          {job.error && (
            <>
              <span className="modal__key">{t("collect.fError")}</span>
              <span style={{ color: "var(--error)" }} data-testid="CollectDetailModal-error">
                {job.error}
              </span>
            </>
          )}
        </div>

        {groups.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}
             data-testid="CollectDetailModal-noCounts">
            {t("collect.noCounts")}
          </p>
        ) : (
          <div className="scroll-area min-h-0" data-testid="CollectDetailModal-counts">
            {groups.map(({ group, items }) => (
              <table className="count-table" key={group}
                     data-testid={`CollectDetailModal-group-${group}`}>
                <thead>
                  <tr>
                    <th colSpan={2}>{t(GROUP_LABEL[group])}</th>
                    <th className="count-table__num">{t("collect.thValue")}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(({ key, value }) => (
                    <tr key={key} data-testid={`CollectDetailModal-count-${key}`}>
                      <td>{getCountLabel(key, t)}</td>
                      <td className="count-table__key"><code>{key}</code></td>
                      <td className="count-table__num">
                        <span className="cnt-pill cnt-pill--lg">{value.toLocaleString()}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
