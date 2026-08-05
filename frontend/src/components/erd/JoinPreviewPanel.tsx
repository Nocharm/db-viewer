"use client";

/** 조인 미리보기 결과 — SQL 탭 / 행 탭. SQL은 W2가 실행한 문장 그대로다.
 * Join preview result: the SQL tab shows exactly what W2 executed. */

import { useState } from "react";

import { CloseIcon } from "@/components/icons";
import { useI18n } from "@/components/i18n";
import type { JoinPreviewResponse } from "@/lib/types";

interface Props {
  result: JoinPreviewResponse | null;
  error: string | null;
  onClose: () => void;
}

/** 행 내용으로 만든 안정 키 — 원본 DB 행엔 id가 없고 목록은 새 미리보기가 올 때만
 * 통째로 교체되므로, 위치가 아니라 내용이 안정 식별자다. 완전히 같은 값의 행이 여럿이면
 * (조인 팬아웃 등) 등장 순번만 덧붙여 키 충돌만 피한다.
 * Content-derived keys: raw rows carry no id, and the list is only ever replaced wholesale
 * on a fresh preview, so content — not position — is the stable identity. Ties (duplicate
 * rows from a join fan-out) get an occurrence suffix purely to dodge a key collision. */
function buildRowKeys(rows: Record<string, unknown>[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const signature = JSON.stringify(row);
    const occurrence = seen.get(signature) ?? 0;
    seen.set(signature, occurrence + 1);
    return occurrence === 0 ? signature : `${signature}#${occurrence}`;
  });
}

export function JoinPreviewPanel({ result, error, onClose }: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"sql" | "rows">("rows");

  if (!result && !error) return null;
  const columns = result && result.rows.length > 0 ? Object.keys(result.rows[0]) : [];
  const rowKeys = result ? buildRowKeys(result.rows) : [];

  return (
    // 바깥 닫기는 mousedown 기준 — click은 mouseup에서 나므로 SQL 텍스트를 드래그
    // 선택하다 밖에서 손을 떼면 모달이 닫혀버린다 / close on mousedown, not mouseup
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
         onMouseDown={onClose}>
      <div
        className="flex max-h-[80vh] w-[56rem] max-w-[94vw] flex-col rounded-xl border p-5"
        style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-card)" }}
        onMouseDown={(e) => e.stopPropagation()}
        data-testid="JoinPreviewPanel-root"
      >
        <div className="mb-2 flex items-center gap-2">
          <button
            className={tab === "rows" ? "btn-primary !py-1 text-xs" : "btn-secondary !py-1 text-xs"}
            onClick={() => setTab("rows")}
            data-testid="JoinPreviewPanel-rowsTab"
          >
            {t("join.tabRows").replace("{n}", String(result?.rows.length ?? 0))}
          </button>
          <button
            className={tab === "sql" ? "btn-primary !py-1 text-xs" : "btn-secondary !py-1 text-xs"}
            onClick={() => setTab("sql")}
            data-testid="JoinPreviewPanel-sqlTab"
          >
            {t("join.tabSql")}
          </button>
          <button className="icon-button ml-auto" onClick={onClose}
                  data-testid="JoinPreviewPanel-closeButton">
            <CloseIcon />
          </button>
        </div>

        {error && (
          <p className="text-sm" style={{ color: "var(--error)" }}
             data-testid="JoinPreviewPanel-error">
            {error}
          </p>
        )}

        {result && tab === "sql" && (
          <div className="scroll-area min-h-0 overflow-auto">
            <pre className="whitespace-pre-wrap font-mono text-xs"
                 data-testid="JoinPreviewPanel-sql">
              {result.query}
            </pre>
            <button
              className="btn-secondary mt-2 !py-1 text-xs"
              onClick={() => void navigator.clipboard.writeText(result.query)}
              data-testid="JoinPreviewPanel-copySql"
            >
              {t("join.copySql")}
            </button>
          </div>
        )}

        {result && tab === "rows" && (
          <div className="scroll-area min-h-0 overflow-auto"
               data-testid="JoinPreviewPanel-rows">
            {result.rows.length === 0 && (
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                {t("join.previewEmpty")}
              </p>
            )}
            {result.rows.length > 0 && (
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c} className="px-2 py-1 text-left font-mono"
                          style={{ color: "var(--muted)" }}>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={rowKeys[i]}>
                      {columns.map((c) => (
                        // null/undefined는 빈 문자열로 — String(undefined)가 "undefined"
                        // 글자 그대로 뜨는 걸 막는다. 값 자체가 문자열 "null"이면 실데이터라
                        // 그대로 보여준다 / coalesce nullish so it never renders as the word
                        // "undefined"; an actual string "null" is real data and passes through
                        <td key={c} className="px-2 py-1 font-mono">{String(row[c] ?? "")}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {result.masked_columns.length > 0 && (
              <p className="mt-2 text-xs" style={{ color: "var(--slate)" }}>
                {t("join.previewMasked").replace("{cols}", result.masked_columns.join(", "))}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
