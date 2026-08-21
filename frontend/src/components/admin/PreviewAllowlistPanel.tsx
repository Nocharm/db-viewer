"use client";

/** 미리보기 허용 스키마 관리 — 목록 편집에 환경변수 비밀번호를 요구한다.
 * Preview allowlist editor (schema-level); edits are gated by the env password. */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  addPreviewAllow,
  fetchPgStatus,
  fetchPgTables,
  fetchPreviewAllowlistAdmin,
  fetchSchemaCategories,
  removePreviewAllow,
  type PreviewAllowEntry,
  type SchemaCategoryItem,
} from "@/lib/api";

/** 목록 한 줄 — 카탈로그 스키마와 `pg:` 키를 같은 표에 세운다 / one row, either source. */
interface AllowRow {
  schema: string;
  object_count: number;
}

export function PreviewAllowlistPanel() {
  const [password, setPassword] = useState("");
  const [entries, setEntries] = useState<PreviewAllowEntry[]>([]);
  const [passwordConfigured, setPasswordConfigured] = useState(true);
  const [schemas, setSchemas] = useState<SchemaCategoryItem[]>([]);
  const [pgSchemas, setPgSchemas] = useState<AllowRow[]>([]);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() =>
    fetchPreviewAllowlistAdmin()
      .then((res) => {
        setEntries(res.items);
        setPasswordConfigured(res.password_configured);
      })
      .catch((e) => setError(e.message)), []);

  useEffect(() => { void reload(); }, [reload]);

  // 스키마 목록은 카탈로그가 곧 원본 — 카테고리 화면과 같은 소스를 쓴다
  useEffect(() => {
    fetchSchemaCategories()
      .then((res) => setSchemas(res.items))
      .catch((e) => setError(e.message));
  }, []);

  // 업무 Postgres는 수집하지 않아 카탈로그에 없다 — 소스에 직접 물어 `pg:` 키로 세운다
  useEffect(() => {
    fetchPgStatus()
      .then((status) => (status.enabled ? fetchPgTables() : null))
      .then((res) => {
        if (!res) return;
        const counts = new Map<string, number>();
        for (const table of res.items) {
          counts.set(table.schema, (counts.get(table.schema) ?? 0) + 1);
        }
        setPgSchemas([...counts].map(([schema, count]) =>
          ({ schema: `pg:${schema}`, object_count: count })));
      })
      // 소스가 안 붙어 있어도 이 화면의 본 업무(카탈로그 스키마)는 그대로 돌아야 한다
      .catch(() => setPgSchemas([]));
  }, []);

  const rows = useMemo<AllowRow[]>(() => [
    ...schemas.map((item) => ({ schema: item.schema, object_count: item.object_count })),
    ...pgSchemas,
  ], [schemas, pgSchemas]);

  const allowedBySchema = useMemo(
    () => new Map(entries.map((entry) => [entry.schema, entry])),
    [entries],
  );

  const visibleSchemas = useMemo(() => {
    const term = query.trim().toLowerCase();
    const matched = term
      ? rows.filter((item) => item.schema.toLowerCase().includes(term))
      : rows;
    // 허용된 스키마를 위로 — 지금 무엇이 열려 있는지가 이 화면의 첫 질문이다
    return [...matched].sort((a, b) => {
      const allowedDiff = Number(allowedBySchema.has(b.schema))
        - Number(allowedBySchema.has(a.schema));
      return allowedDiff !== 0 ? allowedDiff : a.schema.localeCompare(b.schema);
    });
  }, [rows, query, allowedBySchema]);

  const canEdit = passwordConfigured && password.length > 0;

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
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-sm font-medium">미리보기 허용 스키마</h2>
        <span className="badge badge--muted" data-testid="AdminPage-previewAllowCount">
          {entries.length.toLocaleString()} / {rows.length.toLocaleString()}
        </span>
        <input
          className="ml-auto w-56 rounded border px-3 py-1.5 text-sm"
          style={{ borderColor: "var(--border-light)" }}
          placeholder="스키마 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="AdminPage-previewAllowSearchInput"
        />
      </div>
      <p className="mb-3 text-xs" style={{ color: "var(--muted)" }}>
        허용된 스키마의 객체만 실제 값을 미리볼 수 있습니다 (테이블 화면·ERD 공통, 조인 샘플 포함).
        스키마 1건을 허용하면 그 안의 모든 테이블·뷰가 열립니다. 목록이 비어 있으면 전부 차단됩니다.{" "}
        <code>pg:</code>로 시작하는 줄은 업무 Postgres 소스의 스키마입니다.
      </p>

      {!passwordConfigured ? (
        <p className="mb-3 text-sm" style={{ color: "var(--error)" }}
           data-testid="AdminPage-previewAllowNoPassword">
          PREVIEW_ADMIN_PASSWORD가 설정되지 않아 목록을 수정할 수 없습니다 — 서버 .env에
          값을 넣고 백엔드를 재기동하세요.
        </p>
      ) : (
        <div className="mb-3 flex gap-2">
          <input
            className="w-64 rounded border px-3 py-1.5 text-sm"
            style={{ borderColor: "var(--border-light)" }}
            type="password"
            autoComplete="off"
            placeholder="수정 비밀번호 (환경변수)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="AdminPage-previewAllowPasswordInput"
          />
          <input
            className="flex-1 rounded border px-3 py-1.5 text-sm"
            style={{ borderColor: "var(--border-light)" }}
            placeholder="메모 (선택 — 허용 사유)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="AdminPage-previewAllowNoteInput"
          />
        </div>
      )}

      <div className="scroll-area max-h-96 overflow-y-auto"
           data-testid="AdminPage-previewAllowScroll">
        <table className="w-full text-sm" data-testid="AdminPage-previewAllowTable">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--hairline)" }}>
              <th className="py-1.5">스키마</th><th>객체 수</th><th>메모</th>
              <th>등록자</th><th className="w-20"></th>
            </tr>
          </thead>
          <tbody>
            {visibleSchemas.map((item) => {
              const entry = allowedBySchema.get(item.schema);
              return (
                <tr key={item.schema} className="border-b"
                    style={{ borderColor: "var(--border-light)" }}
                    data-testid={`AdminPage-previewAllowRow-${item.schema}`}>
                  <td className="py-1.5 font-mono text-xs">{item.schema}</td>
                  <td className="text-xs" style={{ color: "var(--slate)" }}>
                    {item.object_count.toLocaleString()}
                  </td>
                  <td className="text-xs" style={{ color: "var(--slate)" }}>
                    {entry?.note ?? ""}
                  </td>
                  <td className="text-xs" style={{ color: "var(--muted)" }}>
                    {entry?.added_by ?? ""}
                  </td>
                  <td className="text-right">
                    {entry ? (
                      <button
                        className="icon-button row-action"
                        disabled={!canEdit}
                        title={canEdit ? undefined : "수정 비밀번호를 입력하세요"}
                        onClick={() => run(() => removePreviewAllow(item.schema, password),
                                           `${item.schema} 허용 해제`)}
                        data-testid={`AdminPage-previewAllowRemoveButton-${item.schema}`}
                      >
                        허용 해제
                      </button>
                    ) : (
                      <button
                        className="btn-primary row-action"
                        disabled={!canEdit}
                        title={canEdit ? undefined : "수정 비밀번호를 입력하세요"}
                        onClick={() => run(
                          () => addPreviewAllow(item.schema, password, note.trim() || undefined),
                          `${item.schema} 미리보기 허용`,
                        )}
                        data-testid={`AdminPage-previewAllowAddButton-${item.schema}`}
                      >
                        허용 추가
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {visibleSchemas.length === 0 && (
              <tr><td colSpan={5} className="py-2" style={{ color: "var(--muted)" }}
                      data-testid="AdminPage-previewAllowEmptyState">
                {query.trim() ? "검색 결과 없음" : "스키마 없음 — 카탈로그를 먼저 수집하세요"}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {message && <p className="mt-2 text-sm" style={{ color: "var(--rel-confirmed)" }}
                     data-testid="AdminPage-previewAllowMessage">{message}</p>}
      {error && <p className="mt-2 text-sm" style={{ color: "var(--error)" }}
                   data-testid="AdminPage-previewAllowError">{error}</p>}
    </section>
  );
}
