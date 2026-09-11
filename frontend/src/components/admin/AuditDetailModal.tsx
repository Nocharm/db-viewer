"use client";

/** 감사 행 상세 — 목록은 한 줄로 자르고, 전문은 여기서 보여준다. 직사각형 모달(라운드 8px),
 * Esc·배경 클릭·× 로 닫는다. / full detail of one audit row; the list keeps rows single-line. */

import { useEffect, useRef } from "react";

import { CloseIcon } from "@/components/icons";
import { ACTION_LABELS, getActionCategory, isFailedEntry, type AuditCategory } from "@/lib/audit";
import type { AuditEntry } from "@/lib/api";

export const CATEGORY_BADGE: Record<AuditCategory, string> = {
  exposure: "badge--warn", policy: "badge--view", ops: "badge--muted", login: "badge--login",
};

/** 행의 pill 클래스 — 실패는 분류와 무관하게 빨강 / failed rows are red regardless of category */
export function getAuditBadgeClass(entry: Pick<AuditEntry, "action" | "detail">): string {
  return isFailedEntry(entry.action, entry.detail)
    ? "badge--err"
    : CATEGORY_BADGE[getActionCategory(entry.action)];
}

interface AuditDetailModalProps {
  entry: AuditEntry | null;
  onClose: () => void;
}

export function AuditDetailModal({ entry, onClose }: AuditDetailModalProps) {
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
            {ACTION_LABELS[entry.action] ?? entry.action}
          </span>
          <h3 id="audit-detail-title" className="modal__title">감사 기록 #{entry.id}</h3>
          <button
            ref={closeRef}
            className="icon-button modal__close"
            onClick={onClose}
            aria-label="닫기"
            data-testid="AuditDetailModal-closeButton"
          >
            <CloseIcon size={13} />
          </button>
        </div>
        <div className="modal__grid">
          <span className="modal__key">시각</span>
          <span>{new Date(entry.requested_at).toLocaleString()}</span>
          <span className="modal__key">동작</span>
          <span><code>{entry.action}</code></span>
          <span className="modal__key">요청자</span>
          <span className="font-mono">{entry.requested_by}</span>
          <span className="modal__key">대상</span>
          <span className="font-mono">{entry.target ?? "—"}</span>
        </div>
        <pre className="modal__pre" data-testid="AuditDetailModal-detail">{entry.detail}</pre>
      </div>
    </div>
  );
}
