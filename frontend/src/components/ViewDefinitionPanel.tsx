"use client";

/** 뷰 정의 SQL 패널 — 값 추적 히트와 테이블 상세가 함께 쓴다. 히트 컬럼이 있으면 강조한다.
 *  Shared view-definition panel for the value-probe hits list and the detail pane. */

import { useEffect, useState } from "react";

import { useI18n } from "@/components/i18n";
import { CloseIcon, CodeIcon, CopyIcon } from "@/components/icons";
import { SqlCode } from "@/components/SqlCode";
import { fetchViewDefinition, type ViewDefinition } from "@/lib/api";
import { copyTextToClipboard } from "@/lib/preview-utils";

/** 복사 결과 라벨이 버튼에 머무는 시간(ms) — 지나면 원래 라벨로 돌아간다 */
const COPY_FEEDBACK_MS = 1500;

interface ViewDefinitionPanelProps {
  objectId: number;
  qname: string;
  /** 값 추적 히트에서만 온다 — 정의 SQL 안의 같은 이름 토큰을 강조 / from a value-probe hit */
  highlightColumn?: string | null;
  onClose?: () => void;
}

export function ViewDefinitionPanel({
  objectId, qname, highlightColumn = null, onClose,
}: ViewDefinitionPanelProps) {
  const { t } = useI18n();
  const [definition, setDefinition] = useState<ViewDefinition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);

  // 객체가 바뀌면 이전 정의를 즉시 버린다 — 남겨 두면 다른 뷰의 SQL이 잠깐 보인다
  useEffect(() => {
    let alive = true;
    setDefinition(null);
    setError(null);
    fetchViewDefinition(objectId)
      .then((res) => { if (alive) setDefinition(res); })
      // catch 변수는 unknown이다 — Error가 아닌 값이 와도 "undefined"를 찍지 않게 한다
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => { alive = false; };
  }, [objectId]);

  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const sql = definition?.definition ?? null;

  return (
    <section className="card mt-2 p-3" data-testid="ViewDefinitionPanel-root">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <CodeIcon size={12} />
        <span className="font-semibold">{t("viewdef.title")}</span>
        <code className="font-mono">{qname}</code>
        {highlightColumn && (
          <span className="key-chip" data-testid="ViewDefinitionPanel-hitColumn">
            {t("viewdef.hitColumn")}: {highlightColumn}
          </span>
        )}
        <button
          type="button"
          className="icon-button ml-auto inline-flex items-center gap-1.5"
          disabled={sql === null}
          onClick={() => {
            if (sql === null) return;
            void copyTextToClipboard(sql).then((ok) => setCopied(ok ? "done" : "failed"));
          }}
          data-testid="ViewDefinitionPanel-copyButton"
        >
          <CopyIcon size={12} />
          {copied === "done" && t("viewdef.copied")}
          {copied === "failed" && t("viewdef.copyFailed")}
          {copied === null && t("viewdef.copy")}
        </button>
        {onClose && (
          <button
            type="button"
            className="icon-button inline-flex items-center"
            onClick={onClose}
            title={t("viewdef.close")}
            data-testid="ViewDefinitionPanel-closeButton"
          >
            <CloseIcon size={12} />
          </button>
        )}
      </div>
      {error !== null ? (
        <p className="text-sm" style={{ color: "var(--error)" }}
           data-testid="ViewDefinitionPanel-error">
          {error}
        </p>
      ) : definition === null ? (
        <div className="skeleton h-16" role="status" aria-label={t("viewdef.loading")}
             data-testid="ViewDefinitionPanel-loading" />
      ) : sql === null ? (
        <p className="hint-pill" data-testid="ViewDefinitionPanel-missing">
          {t("viewdef.missing")}
        </p>
      ) : (
        <div data-testid="ViewDefinitionPanel-code">
          <SqlCode sql={sql} highlightColumn={highlightColumn} />
        </div>
      )}
    </section>
  );
}
