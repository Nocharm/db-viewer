"use client";

/** 현재 미리보기 상태를 SQL로 보여주고 복사 — HTTP에서도 동작. 컬럼 칩 편집으로
 * 일괄 숨김 지원 / view-as-SQL with copy, plus pill-based bulk column hiding. */

import { useEffect, useState } from "react";

import { CloseIcon, CodeIcon } from "@/components/icons";
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
  /** 숨김 포함 전체 컬럼(화면 순서) — 고스트 칩이 복원 경로를 연다 */
  allColumns: string[];
  sort: SortSpec | null;
  /** 칩 편집 적용 — 남길 컬럼 목록(순서 포함)을 받아 숨김·순서를 갱신한다 */
  onApplyColumns: (visible: string[]) => void;
  buttonClassName?: string;
}

export function PreviewSqlButton({
  state, visibleColumns, allColumns, sort, onApplyColumns, buttonClassName,
}: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  // 칩 편집 스테이징 — 전체 컬럼 위의 "포함 집합". 빼는 것(×/Backspace)뿐 아니라 이미
  // 숨긴 컬럼도 고스트 칩 클릭으로 되살린 뒤 「적용」에서 한 번에 반영한다.
  // (제외 전용 스테이징은 적용 후 다시 열면 누적 제외만 가능했다 — 사용자 리포트)
  const [editOpen, setEditOpen] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());

  // 적용(또는 외부 변경)으로 보이는 컬럼이 바뀌면 스테이징도 그 상태에서 다시 시작
  useEffect(() => {
    setPending(new Set(visibleColumns));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 내용 기준 동기화
  }, [visibleColumns.join(" ")]);

  const togglePending = (column: string) =>
    setPending((cur) => {
      const next = new Set(cur);
      if (next.has(column)) next.delete(column);
      else next.add(column);
      return next;
    });
  // 적용 결과가 될 목록 — 전체 컬럼 순서에서 포함된 것만
  const includedList = allColumns.filter((column) => pending.has(column));
  const visibleSet = new Set(visibleColumns);
  const removedCount = visibleColumns.filter((column) => !pending.has(column)).length;
  const restoredCount = includedList.filter((column) => !visibleSet.has(column)).length;
  const isDirty = removedCount > 0 || restoredCount > 0;
  const sql = open ? buildPreviewSql(state, visibleColumns, sort) : "";

  return (
    <>
      <button className={buttonClassName ?? "icon-button"}
              onClick={() => {
                setOpen(true);
                setCopied("idle");
                // 재진입은 항상 닫힌 에디터에서 — 이전 세션의 editOpen이 남으면
                // 「컬럼 편집」 첫 클릭이 열기가 아니라 닫기가 된다
                setEditOpen(false);
              }}
              data-testid="PreviewSqlButton-openButton">
        <CodeIcon size={11} className="mr-1 inline-block align-middle" />
        {t("preview.sqlView")}
      </button>
      {open && (
        // 바깥 닫기는 mousedown 기준 — SQL 텍스트를 드래그 선택하다 밖에서 손을 떼면
        // click(mouseup)으로는 모달이 닫혀버린다
        // close on mousedown; selecting SQL text and releasing outside would close it
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
             onMouseDown={() => setOpen(false)}>
          <div
            className="flex max-h-[70vh] w-[36rem] max-w-[90vw] flex-col rounded-xl border p-4"
            style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-card)" }}
            onMouseDown={(e) => e.stopPropagation()}
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
                <CloseIcon />
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
            {/* 컬럼 칩 편집 — SELECT 목록을 전체 컬럼 필로 늘어놓는다. 보이는 컬럼은
                ×/Backspace로 빼고, 숨긴 컬럼은 제자리의 흐린 고스트 칩을 눌러 복원 —
                적용 후 다시 열어도 양방향 편집이 가능하다 */}
            {editOpen && (
              <div className="mt-3">
                <p className="mb-1.5 text-xs" style={{ color: "var(--muted)" }}>
                  {t("preview.editColumnsHint")}
                </p>
                <div
                  tabIndex={0}
                  className="scroll-area flex max-h-36 flex-wrap content-start gap-1.5 overflow-y-auto rounded-lg border p-2"
                  style={{ borderColor: "var(--hairline)", background: "var(--surface-elevated)" }}
                  onKeyDown={(e) => {
                    // Backspace = 포함된 마지막 칩부터 컬럼 단위 삭제 / drop the last kept pill
                    if (e.key === "Backspace" && includedList.length > 0) {
                      e.preventDefault();
                      togglePending(includedList[includedList.length - 1]);
                    }
                  }}
                  data-testid="PreviewSqlButton-columnPills"
                >
                  {allColumns.map((column) => (pending.has(column) ? (
                    <span key={column}
                          className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px]"
                          style={{ borderColor: "var(--hairline-strong)",
                                   background: "var(--surface-card)", color: "var(--body-text)" }}
                          data-testid={`PreviewSqlButton-pill-${column}`}>
                      {column}
                      <button
                        className="pressable rounded-full leading-none"
                        style={{ color: "var(--muted)" }}
                        title={t("preview.hideColumn")}
                        onClick={() => togglePending(column)}
                        data-testid={`PreviewSqlButton-pillRemove-${column}`}
                      >
                        <CloseIcon size={9} />
                      </button>
                    </span>
                  ) : (
                    // 제외된 컬럼 — 제자리에 남는 고스트 칩, 클릭으로 복원
                    <button key={column}
                            className="pressable rounded-full border border-dashed px-2 py-0.5 font-mono text-[11px]"
                            style={{ borderColor: "var(--hairline-strong)", color: "var(--muted-soft)" }}
                            title={t("preview.restoreColumn")}
                            onClick={() => togglePending(column)}
                            data-testid={`PreviewSqlButton-ghostPill-${column}`}>
                      {column}
                    </button>
                  )))}
                  {includedList.length === 0 && (
                    <span className="text-xs" style={{ color: "var(--error)" }}>
                      {t("preview.editColumnsEmpty")}
                    </span>
                  )}
                </div>
              </div>
            )}
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
              <button
                className="btn-secondary ml-auto !py-1.5 text-xs"
                onClick={() => {
                  setEditOpen((cur) => !cur);
                  setPending(new Set(visibleColumns));
                }}
                data-testid="PreviewSqlButton-editColumnsButton"
              >
                {t("preview.editColumns")}
              </button>
              {editOpen && (
                <>
                  <button
                    className="btn-secondary !py-1.5 text-xs"
                    disabled={pending.size === allColumns.length}
                    onClick={() => setPending(new Set(allColumns))}
                    data-testid="PreviewSqlButton-showAllColumnsButton"
                  >
                    {t("preview.showAllColumns")}
                  </button>
                  <button
                    className="btn-primary !py-1.5 text-xs"
                    disabled={!isDirty || includedList.length === 0}
                    onClick={() => onApplyColumns(includedList)}
                    data-testid="PreviewSqlButton-applyColumnsButton"
                  >
                    {isDirty
                      ? `${t("preview.applyColumns")} (${[
                          removedCount > 0 ? `−${removedCount}` : "",
                          restoredCount > 0 ? `+${restoredCount}` : "",
                        ].filter(Boolean).join(" ")})`
                      : t("preview.applyColumns")}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
