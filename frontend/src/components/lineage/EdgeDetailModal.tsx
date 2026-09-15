"use client";

/** 간선 관계 정보 — 라벨을 누르면 열린다. 라벨은 한두 조각만 담을 수 있어 전체는 여기서 본다. */

import { useEffect } from "react";

import { CloseIcon } from "@/components/icons";
import { useI18n } from "@/components/i18n";
import type { EdgeDetail } from "@/components/lineage/LineageEdge";

interface Props {
  detail: EdgeDetail;
  onClose: () => void;
}

export function EdgeDetailModal({ detail, onClose }: Props) {
  const { t } = useI18n();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose} data-testid="EdgeDetailModal-backdrop">
      <div
        className="modal"
        style={{ width: "min(520px, 100%)" }}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label={detail.title}
        data-testid="EdgeDetailModal-root"
      >
        <div className="modal__head">
          <h3 className="modal__title">{detail.title}</h3>
          <button className="icon-button modal__close" onClick={onClose}
                  data-testid="EdgeDetailModal-closeButton">
            <CloseIcon size={12} />
          </button>
        </div>

        <dl className="modal__grid">
          {detail.rows.map((row) => (
            <div key={row.label} style={{ display: "contents" }}>
              <dt className="modal__key">{row.label}</dt>
              <dd style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: 12.5 }}>
                {row.value}
              </dd>
            </div>
          ))}
        </dl>

        {detail.columns.length > 0 && (
          <div>
            <p className="modal__key" style={{ marginBottom: 6 }}>
              {t("lineage.edgeColumns")} ({detail.columns.length})
            </p>
            <div className="flex flex-wrap gap-1.5" data-testid="EdgeDetailModal-columns">
              {detail.columns.map((column) => (
                <span key={column} className="key-chip">{column}</span>
              ))}
            </div>
          </div>
        )}

        {detail.note && (
          <p className="text-xs" style={{ color: "var(--muted)", margin: 0 }}>{detail.note}</p>
        )}
      </div>
    </div>
  );
}
