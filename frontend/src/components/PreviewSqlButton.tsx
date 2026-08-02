"use client";

/** 현재 미리보기 상태를 SQL로 보여주고 복사 — HTTP에서도 동작 / view-as-SQL with copy. */

import { useState } from "react";

import { useI18n } from "@/components/i18n";
import {
  buildPreviewSql,
  copyTextToClipboard,
  tokenizeSql,
  type PreviewQueryState,
  type SortSpec,
  type SqlToken,
} from "@/lib/preview-utils";

// 토큰 타입별 색 — 두 테마에서 유효한 시맨틱 토큰만 사용 / theme-safe token colors
const TOKEN_STYLES: Record<SqlToken["type"], React.CSSProperties> = {
  keyword: { color: "var(--obj-view)", fontWeight: 600 },
  identifier: { color: "var(--ink)" },
  string: { color: "var(--rel-confirmed)" },
  number: { color: "var(--rel-ai)" },
  plain: { color: "var(--slate)" },
};

interface Props {
  state: PreviewQueryState;
  visibleColumns: string[];
  sort: SortSpec | null;
  buttonClassName?: string;
}

export function PreviewSqlButton({ state, visibleColumns, sort, buttonClassName }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const sql = open ? buildPreviewSql(state, visibleColumns, sort) : "";

  return (
    <>
      <button className={buttonClassName ?? "icon-button"}
              onClick={() => { setOpen(true); setCopied("idle"); }}
              data-testid="PreviewSqlButton-openButton">
        {t("preview.sqlView")}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
             onClick={() => setOpen(false)}>
          <div
            className="flex max-h-[70vh] w-[36rem] max-w-[90vw] flex-col rounded-xl border p-4"
            style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-card)" }}
            onClick={(e) => e.stopPropagation()}
            data-testid="PreviewSqlButton-modal"
          >
            <div className="mb-1 flex items-center gap-2">
              <span className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
                {t("preview.sqlView")}
              </span>
              <span className="font-mono text-xs" style={{ color: "var(--muted)" }}>
                {state.object}
              </span>
              <button className="icon-button ml-auto" onClick={() => setOpen(false)}
                      data-testid="PreviewSqlButton-closeButton">
                ✕
              </button>
            </div>
            <p className="mb-2 text-xs" style={{ color: "var(--muted)" }}>
              {t("preview.sqlHint")}
            </p>
            <pre
              className="scroll-area min-h-0 overflow-auto rounded-lg border p-3 font-mono text-xs leading-relaxed"
              style={{ borderColor: "var(--hairline)", background: "var(--surface-elevated)" }}
              data-testid="PreviewSqlButton-sqlText"
            >
              {tokenizeSql(sql).map((token, index) => (
                <span key={index} style={TOKEN_STYLES[token.type]}>{token.text}</span>
              ))}
            </pre>
            <div className="mt-3 flex items-center gap-2">
              <button
                className="btn-primary"
                onClick={() => {
                  void copyTextToClipboard(sql).then((ok) =>
                    setCopied(ok ? "done" : "failed"));
                }}
                data-testid="PreviewSqlButton-copyButton"
              >
                {copied === "done" ? t("preview.copied") : t("preview.copy")}
              </button>
              {copied === "failed" && (
                <span className="text-xs" style={{ color: "var(--error)" }}>
                  {t("preview.copyFailed")}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
