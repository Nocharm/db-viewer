"use client";

/** 미리보기 허용 스키마 관리 — 목록 편집에 환경변수 비밀번호를 요구한다(관리 콘솔 잠금 바가 쥔다).
 * Preview allowlist editor (schema-level); edits are gated by the env password from the lock bar. */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  addPreviewAllow,
  fetchPreviewAllowlistAdmin,
  fetchSchemaCategories,
  removePreviewAllow,
  type PreviewAllowEntry,
  type SchemaCategoryItem,
} from "@/lib/api";
import { BanIcon, CheckIcon, PlusIcon, ShieldIcon, WarningIcon } from "@/components/icons";

interface PreviewAllowlistPanelProps {
  /** 허용 목록 PK가 (data_source_id, schema)라 소스별로 조회·수정한다 — null은 사내 MSSQL. */
  sourceId: number | null;
  /** 관리 비밀번호(X-Preview-Password) — 관리 콘솔 잠금 바가 쥔 값 */
  password: string;
  passwordConfigured: boolean;
  /** 허용 스키마 수를 알린다 — 탭 카운트 pill용 */
  onLoaded?: (allowed: number) => void;
}

export function PreviewAllowlistPanel({
  sourceId, password, passwordConfigured, onLoaded,
}: PreviewAllowlistPanelProps) {
  const [entries, setEntries] = useState<PreviewAllowEntry[]>([]);
  const [schemas, setSchemas] = useState<SchemaCategoryItem[]>([]);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() =>
    fetchPreviewAllowlistAdmin(sourceId)
      .then((res) => {
        setEntries(res.items);
        onLoaded?.(res.items.length);
      })
      .catch((e) => setError(e.message)), [sourceId, onLoaded]);

  useEffect(() => { void reload(); }, [reload]);

  // 스키마 목록은 카탈로그가 곧 원본 — 카테고리 화면과 같은 소스를 쓴다
  useEffect(() => {
    fetchSchemaCategories(sourceId)
      .then((res) => setSchemas(res.items))
      .catch((e) => setError(e.message));
  }, [sourceId]);

  const allowedBySchema = useMemo(
    () => new Map(entries.map((entry) => [entry.schema, entry])),
    [entries],
  );

  const visibleSchemas = useMemo(() => {
    const term = query.trim().toLowerCase();
    const rows = term
      ? schemas.filter((item) => item.schema.toLowerCase().includes(term))
      : schemas;
    // 허용된 스키마를 위로 — 지금 무엇이 열려 있는지가 이 화면의 첫 질문이다
    return [...rows].sort((a, b) => {
      const allowedDiff = Number(allowedBySchema.has(b.schema))
        - Number(allowedBySchema.has(a.schema));
      return allowedDiff !== 0 ? allowedDiff : a.schema.localeCompare(b.schema);
    });
  }, [schemas, query, allowedBySchema]);

  const canEdit = passwordConfigured && password.length > 0;
  const lockedTitle = canEdit ? undefined : "잠금 바에 관리 비밀번호를 입력하세요";

  const run = (task: () => Promise<unknown>, done: string) => {
    setError(null);
    setMessage(null);
    task()
      .then(() => {
        setMessage(done);
        return reload();
      })
      .catch((e) => setError(e.message));
  };

  return (
    <section className="mb-6" data-testid="AdminPage-previewAllowSection">
      <div className="sec-head">
        <span className="sec-head__tile"><ShieldIcon size={14} /></span>
        <h2 className="sec-head__title">미리보기 허용 스키마</h2>
        <span className="cnt-pill" data-testid="AdminPage-previewAllowCount">
          허용 {entries.length.toLocaleString()} · 전체 {schemas.length.toLocaleString()}
        </span>
        <div className="sec-head__right">
          <input
            className="ctl-field w-52"
            placeholder="스키마 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="AdminPage-previewAllowSearchInput"
          />
        </div>
      </div>
      <p className="sec-desc">
        허용된 스키마의 객체만 실제 값을 미리볼 수 있습니다 (테이블 화면·ERD·조인 샘플·값 추적 공통).
        스키마 1건을 허용하면 그 안의 모든 테이블·뷰가 열립니다. 목록이 비어 있으면 전부 차단됩니다.
      </p>

      {passwordConfigured && (
        <div className="mb-3 flex gap-2">
          <input
            className="ctl-field flex-1"
            placeholder="메모 (선택 — 허용 사유, 다음 허용 추가에 붙습니다)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="AdminPage-previewAllowNoteInput"
          />
        </div>
      )}

      <div className="card">
        <div className="scroll-area max-h-96 overflow-y-auto"
             data-testid="AdminPage-previewAllowScroll">
          <table className="data-table" data-testid="AdminPage-previewAllowTable">
            <colgroup>
              <col style={{ width: "26%" }} /><col style={{ width: "12%" }} />
              <col /><col style={{ width: "20%" }} /><col style={{ width: "120px" }} />
            </colgroup>
            <thead>
              <tr><th>스키마</th><th>객체</th><th>메모</th><th>등록</th><th></th></tr>
            </thead>
            <tbody>
              {visibleSchemas.map((item) => {
                const entry = allowedBySchema.get(item.schema);
                return (
                  <tr key={item.schema} className="reveal-host"
                      data-testid={`AdminPage-previewAllowRow-${item.schema}`}>
                    <td>
                      <span className="font-mono text-xs" style={{ color: "var(--ink)" }}>{item.schema}</span>
                      {entry && <span className="badge badge--ok badge--plain ml-2"><CheckIcon size={11} />허용</span>}
                    </td>
                    <td><span className="cnt-pill">{item.object_count.toLocaleString()}</span></td>
                    <td className="text-xs" style={{ color: "var(--slate)" }}>{entry?.note ?? ""}</td>
                    <td className="text-xs" style={{ color: "var(--muted)" }}>{entry?.added_by ?? ""}</td>
                    <td className="text-right">
                      {entry ? (
                        <button
                          className="icon-button reveal-action ctl-field--danger"
                          disabled={!canEdit}
                          title={lockedTitle}
                          onClick={() => run(
                            () => removePreviewAllow(item.schema, password, sourceId),
                            `${item.schema} 허용 해제`)}
                          data-testid={`AdminPage-previewAllowRemoveButton-${item.schema}`}
                        >
                          <BanIcon size={13} />허용 해제
                        </button>
                      ) : (
                        <button
                          className="btn-primary reveal-action inline-flex items-center gap-1.5 !px-3 !py-1.5 text-xs"
                          disabled={!canEdit}
                          title={lockedTitle}
                          onClick={() => run(
                            () => addPreviewAllow(
                              item.schema, password, note.trim() || undefined, sourceId,
                            ),
                            `${item.schema} 미리보기 허용`,
                          )}
                          data-testid={`AdminPage-previewAllowAddButton-${item.schema}`}
                        >
                          <PlusIcon size={12} />허용 추가
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {visibleSchemas.length === 0 && (
                <tr><td colSpan={5} style={{ color: "var(--muted)" }}
                        data-testid="AdminPage-previewAllowEmptyState">
                  {query.trim() ? "검색 결과 없음" : "스키마 없음 — 카탈로그를 먼저 수집하세요"}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {message && (
        <div className="banner banner--ok mt-3" data-testid="AdminPage-previewAllowMessage">
          <CheckIcon size={15} /><span>{message}</span>
        </div>
      )}
      {error && (
        <div className="banner banner--err mt-3" data-testid="AdminPage-previewAllowError">
          <WarningIcon size={15} /><span>{error}</span>
        </div>
      )}
    </section>
  );
}
