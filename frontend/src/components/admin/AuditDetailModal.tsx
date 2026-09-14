"use client";

/** 감사 행 상세 — 목록은 한 줄로 자르고, 전문은 여기서 보여준다. 직사각형 모달(라운드 8px),
 * Esc·배경 클릭·× 로 닫는다. / full detail of one audit row; the list keeps rows single-line. */

import { useEffect, useRef } from "react";

import { useI18n } from "@/components/i18n";
import { CloseIcon } from "@/components/icons";
import { ACTION_LABEL_KEYS, getActionCategory, isFailedEntry, type AuditCategory } from "@/lib/audit";
import type { AuditEntry } from "@/lib/api";
import type { MessageKey } from "@/lib/i18n";

export const CATEGORY_BADGE: Record<AuditCategory, string> = {
  exposure: "badge--warn", policy: "badge--view", ops: "badge--muted", login: "badge--login",
};

/** 행의 pill 클래스 — 실패는 분류와 무관하게 빨강 / failed rows are red regardless of category */
export function getAuditBadgeClass(entry: Pick<AuditEntry, "action" | "detail">): string {
  return isFailedEntry(entry.action, entry.detail)
    ? "badge--err"
    : CATEGORY_BADGE[getActionCategory(entry.action)];
}

/** 동작 라벨 — 사전에 없는 새 action은 코드를 그대로 보여준다 / unknown actions show raw */
export function getActionLabel(action: string, t: (key: MessageKey) => string): string {
  const key = ACTION_LABEL_KEYS[action];
  return key ? t(key) : action;
}

interface AuditDetailModalProps {
  entry: AuditEntry | null;
  onClose: () => void;
}

export function AuditDetailModal({ entry, onClose }: AuditDetailModalProps) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!entry) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entry, onClose]);

  if (!entry) return null;

  return (
    <div className="modal-backdrop" onClick={onClose} data-testid="AuditDetailModal-root">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="audit-detail-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <span className={`badge badge--plain ${getAuditBadgeClass(entry)}`}>
            {getActionLabel(entry.action, t)}
          </span>
          <h3 id="audit-detail-title" className="modal__title">
            {t("audit.detailTitle").replace("{id}", String(entry.id))}
          </h3>
          <button
            ref={closeRef}
            className="icon-button modal__close"
            onClick={onClose}
            aria-label={t("common.close")}
            data-testid="AuditDetailModal-closeButton"
          >
            <CloseIcon size={13} />
          </button>
        </div>
        <div className="modal__grid">
          <span className="modal__key">{t("audit.fWhen")}</span>
          <span>{new Date(entry.requested_at).toLocaleString()}</span>
          <span className="modal__key">{t("audit.fAction")}</span>
          <span><code>{entry.action}</code></span>
          <span className="modal__key">{t("audit.fRequester")}</span>
          <span className="font-mono">{entry.requested_by}</span>
          <span className="modal__key">{t("audit.fTarget")}</span>
          <span className="font-mono">{entry.target ?? "—"}</span>
        </div>
        <pre className="modal__pre" data-testid="AuditDetailModal-detail">{entry.detail}</pre>
      </div>
    </div>
  );
}
