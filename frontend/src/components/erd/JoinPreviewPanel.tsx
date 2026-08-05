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
  /** 이전 결과가 화면에 남아 있는 동안 새 조인이 조회 중임을 알린다 — 원본 값이 나가는
   * 화면이라 "이전 결과를 새 결과로 착각"이 그냥 UX 흠이 아니라 데이터 오귀속이다.
   * A new fetch may be in flight while a previous result/error is still on screen; since
   * this panel shows raw source values, mistaking stale data for fresh isn't just bad UX,
   * it's misattributed data. */
  busy: boolean;
  onClose: () => void;
}

/** 이 목록에서는 컬럼 키가 첫 행에만 있다고 가정할 수 없다 — n8n 어댑터가 아직 라이브에
 * 연결되지 않아 행 JSON이 키-동질적이라는 보장이 없다. 등장 순서를 지키며 전 행을 합친다.
 * Column keys can't be assumed to exist on row 0 alone — the adapter isn't wired to a live
 * n8n yet, so row JSON key-homogeneity isn't guaranteed. Union across all rows, first-seen order. */
function buildColumns(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return columns;
}

export function JoinPreviewPanel({ result, error, busy, onClose }: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"sql" | "rows">("rows");

  if (!result && !error && !busy) return null;
  const columns = result ? buildColumns(result.rows) : [];

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

        {/* 조회 중엔 이전 결과/에러를 완전히 대체한다 — 부분적으로 흐리기만 하면 원본 값이
            여전히 읽혀 "이전 조인의 값을 지금 조인 것으로" 오귀속될 수 있다
            / fully replaces the previous result/error while a fetch is in flight — dimming it
            instead would still let raw values from the previous join be read as the current one */}
        {busy && (
          <p className="text-sm" style={{ color: "var(--muted)" }}
             data-testid="JoinPreviewPanel-busy">
            {t("common.loading")}
          </p>
        )}

        {!busy && error && (
          <p className="text-sm" style={{ color: "var(--error)" }}
             data-testid="JoinPreviewPanel-error">
            {error}
          </p>
        )}

        {!busy && result && tab === "sql" && (
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

        {!busy && result && tab === "rows" && (
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
                    // 인덱스 키가 안전하다 — 이 목록은 서버가 20행으로 고정하고, 새 조회마다
                    // 통째로 교체되며, 안에서 재정렬·삽입·삭제되지 않는다. 인덱스 키가 문제가
                    // 되는 경우(포커스 유실, 엉뚱한 행에 붙은 상태)는 애초에 발생할 수 없다
                    // index keys are safe here: the server caps this at 20 rows, the whole list
                    // is replaced wholesale on every fetch, and nothing reorders/inserts/removes
                    // in place — none of the failure modes index keys actually cause (lost
                    // focus, state bound to the wrong row) can occur
                    <tr key={i}>
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
