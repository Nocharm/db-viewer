"use client";

/** 미리보기 허용 테이블 관리 — 목록 편집에 환경변수 비밀번호를 요구한다.
 * Preview allowlist editor; edits are gated by the env password. */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  addPreviewAllow,
  fetchPreviewAllowlistAdmin,
  removePreviewAllow,
  searchObjects,
  type PreviewAllowEntry,
} from "@/lib/api";
import type { ObjectSummary } from "@/lib/types";

// 입력이 멎은 뒤 질의까지 대기(ms) — AdUserList와 같은 관용
const SEARCH_DEBOUNCE_MS = 300;
// 후보 목록에 그리는 최대 건수 — 검색을 좁히도록 유도한다
const CANDIDATE_LIMIT = 20;

export function PreviewAllowlistPanel() {
  const [password, setPassword] = useState("");
  const [entries, setEntries] = useState<PreviewAllowEntry[]>([]);
  const [passwordConfigured, setPasswordConfigured] = useState(true);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<ObjectSummary[]>([]);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 늦게 온 옛 검색 응답이 새 결과를 덮지 않게 한다 / guards out-of-order responses
  const requestRef = useRef(0);

  const reload = useCallback(() =>
    fetchPreviewAllowlistAdmin()
      .then((res) => {
        setEntries(res.items);
        setPasswordConfigured(res.password_configured);
      })
      .catch((e) => setError(e.message)), []);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    const term = query.trim();
    if (!term) {
      setCandidates([]);
      return;
    }
    const timer = setTimeout(() => {
      const requestId = ++requestRef.current;
      searchObjects(term)
        .then((res) => {
          if (requestId !== requestRef.current) return;
          setCandidates(res.items.slice(0, CANDIDATE_LIMIT));
        })
        .catch((e) => setError(e.message));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const allowed = new Set(entries.map((entry) => entry.qname));
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
        <h2 className="text-sm font-medium">미리보기 허용 테이블</h2>
        <span className="badge badge--muted" data-testid="AdminPage-previewAllowCount">
          {entries.length.toLocaleString()}
        </span>
      </div>
      <p className="mb-3 text-xs" style={{ color: "var(--muted)" }}>
        여기 등록된 객체만 실제 값을 미리볼 수 있습니다 (테이블 화면·ERD 공통, 조인 샘플 포함).
        목록이 비어 있으면 전부 차단됩니다.
      </p>

      {!passwordConfigured ? (
        <p className="mb-3 text-sm" style={{ color: "var(--error)" }}
           data-testid="AdminPage-previewAllowNoPassword">
          PREVIEW_ADMIN_PASSWORD가 설정되지 않아 목록을 수정할 수 없습니다 — 서버 .env에
          값을 넣고 백엔드를 재기동하세요.
        </p>
      ) : (
        <input
          className="mb-3 w-64 rounded border px-3 py-1.5 text-sm"
          style={{ borderColor: "var(--border-light)" }}
          type="password"
          autoComplete="off"
          placeholder="수정 비밀번호 (환경변수)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="AdminPage-previewAllowPasswordInput"
        />
      )}

      <div className="mb-3 flex gap-2">
        <input
          className="flex-1 rounded border px-3 py-1.5 text-sm"
          style={{ borderColor: "var(--border-light)" }}
          placeholder="테이블 검색 (예: HR_EMP)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="AdminPage-previewAllowSearchInput"
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

      {candidates.length > 0 && (
        <ul className="mb-3 rounded border" style={{ borderColor: "var(--hairline)" }}
            data-testid="AdminPage-previewAllowCandidates">
          {candidates.map((obj) => {
            const qname = `${obj.schema}.${obj.name}`;
            return (
              <li key={obj.id}
                  className="flex items-center gap-2 border-b px-3 py-1.5 text-sm last:border-b-0"
                  style={{ borderColor: "var(--border-light)" }}
                  data-testid={`AdminPage-previewAllowCandidate-${qname}`}>
                <span className="font-mono text-xs">{qname}</span>
                <span className="badge badge--muted">{obj.type}</span>
                {allowed.has(qname) ? (
                  <span className="ml-auto text-xs" style={{ color: "var(--rel-confirmed)" }}>
                    허용됨
                  </span>
                ) : (
                  <button
                    className="btn-primary ml-auto"
                    disabled={!canEdit}
                    title={canEdit ? undefined : "수정 비밀번호를 입력하세요"}
                    onClick={() => run(
                      () => addPreviewAllow(qname, password, note.trim() || undefined),
                      `${qname} 미리보기 허용`,
                    )}
                    data-testid={`AdminPage-previewAllowAddButton-${qname}`}
                  >
                    허용 추가
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <table className="w-full text-sm" data-testid="AdminPage-previewAllowTable">
        <thead>
          <tr className="border-b text-left" style={{ borderColor: "var(--hairline)" }}>
            <th className="py-1.5">테이블</th><th>메모</th><th>등록자</th><th></th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.qname} className="border-b"
                style={{ borderColor: "var(--border-light)" }}
                data-testid={`AdminPage-previewAllowRow-${entry.qname}`}>
              <td className="py-1.5 font-mono text-xs">{entry.qname}</td>
              <td className="text-xs" style={{ color: "var(--slate)" }}>{entry.note ?? ""}</td>
              <td className="text-xs" style={{ color: "var(--muted)" }}>{entry.added_by}</td>
              <td className="text-right">
                <button
                  className="icon-button"
                  disabled={!canEdit}
                  title={canEdit ? undefined : "수정 비밀번호를 입력하세요"}
                  onClick={() => run(() => removePreviewAllow(entry.qname, password),
                                     `${entry.qname} 허용 해제`)}
                  data-testid={`AdminPage-previewAllowRemoveButton-${entry.qname}`}
                >
                  삭제
                </button>
              </td>
            </tr>
          ))}
          {entries.length === 0 && (
            <tr><td colSpan={4} className="py-2" style={{ color: "var(--muted)" }}>
              허용된 테이블 없음 — 현재 모든 미리보기가 차단됩니다
            </td></tr>
          )}
        </tbody>
      </table>

      {message && <p className="mt-2 text-sm" style={{ color: "var(--rel-confirmed)" }}
                     data-testid="AdminPage-previewAllowMessage">{message}</p>}
      {error && <p className="mt-2 text-sm" style={{ color: "var(--error)" }}
                   data-testid="AdminPage-previewAllowError">{error}</p>}
    </section>
  );
}
