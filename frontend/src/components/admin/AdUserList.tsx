"use client";

/** AD 동기 사용자 목록 — 서버 검색 + 무한 스크롤. / AD user list with server search and paging. */

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchUsers, type AppUserEntry } from "@/lib/api";

// 한 번에 받아오는 인원 수 — 백엔드 기본값과 맞춘다 / page size, mirrors the backend default
const PAGE_SIZE = 100;
// 입력이 멎은 뒤 질의까지 대기(ms) — 타이핑마다 서버를 두들기지 않는다
const SEARCH_DEBOUNCE_MS = 300;

interface AdUserListProps {
  /** 화이트리스트 등록된 login_id — 행의 허용 여부 표시에 쓴다. */
  whitelisted: Set<string>;
  /** 허용 추가 실행 — 성공 시 상위가 화이트리스트를 갱신한다. */
  onAllow: (user: AppUserEntry) => void;
  /** 값이 바뀌면 목록을 처음부터 다시 읽는다 (AD 동기화 직후 등). */
  refreshKey: number;
}

export function AdUserList({ whitelisted, onAllow, refreshKey }: AdUserListProps) {
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<AppUserEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 요청 순서가 뒤집혀 옛 결과가 새 결과를 덮는 것을 막는다 / guards out-of-order responses
  const requestRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback((term: string, offset: number) => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    fetchUsers({ q: term, offset, limit: PAGE_SIZE })
      .then((page) => {
        if (requestId !== requestRef.current) return;  // 늦게 온 옛 응답은 버린다
        setUsers((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
        setTotal(page.total);
        setHasMore(page.has_more);
      })
      .catch((e) => {
        if (requestId === requestRef.current) setError(e.message);
      })
      .finally(() => {
        if (requestId === requestRef.current) setLoading(false);
      });
  }, []);

  // 검색어 변경(디바운스) + 외부 갱신 신호 → 첫 페이지부터 다시
  useEffect(() => {
    const timer = setTimeout(() => load(query.trim(), 0), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, refreshKey, load]);

  // 바닥 감지 → 다음 페이지 / observe the sentinel to append the next page
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || loading) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) load(query.trim(), users.length);
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, users.length, query, load]);

  return (
    <section className="mb-6" data-testid="AdminPage-adUsersSection">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-medium">AD 사용자</h2>
        <span className="badge badge--muted" data-testid="AdminPage-adUserCount">
          {users.length.toLocaleString()} / {total.toLocaleString()}
        </span>
        <input
          className="ml-auto w-56 rounded border px-3 py-1.5 text-sm"
          style={{ borderColor: "var(--border-light)" }}
          placeholder="이름·ID·부서 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="AdminPage-userFilterInput"
        />
      </div>
      <p className="mb-2 text-xs" style={{ color: "var(--muted)" }}>
        검색은 동기화된 전체 인원을 대상으로 합니다. 로그인 허용은 위 화이트리스트가 결정합니다.
      </p>

      <div className="scroll-area max-h-96 overflow-y-auto" data-testid="AdminPage-adUsersScroll">
        <table className="w-full text-sm" data-testid="AdminPage-adUsersTable">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--hairline)" }}>
              <th className="py-1.5">login_id</th><th>이름</th><th>부서</th>
              <th>이메일</th><th className="w-16"></th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.login_id} className="group border-b"
                  style={{ borderColor: "var(--border-light)" }}
                  data-testid={`AdminPage-adUserRow-${user.login_id}`}>
                <td className="py-1.5 font-mono text-xs">{user.login_id}</td>
                <td>{user.name ?? "—"}</td>
                <td className="text-xs" style={{ color: "var(--slate)" }}>
                  {user.department ?? "—"}
                </td>
                <td className="text-xs" style={{ color: "var(--slate)" }}>
                  {user.email ?? "—"}
                </td>
                <td className="text-right">
                  {whitelisted.has(user.login_id) ? (
                    <span className="text-xs" style={{ color: "var(--rel-confirmed)" }}
                          title="로그인 허용됨">허용됨</span>
                  ) : (
                    // 평소엔 숨고 행 호버·키보드 포커스에서만 보인다 / hover- and focus-revealed
                    <button
                      className="icon-button opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      title={`${user.login_id} 로그인 허용 추가`}
                      aria-label={`${user.login_id} 로그인 허용 추가`}
                      onClick={() => onAllow(user)}
                      data-testid={`AdminPage-allowButton-${user.login_id}`}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
                           stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                        <path d="M8 3v10M3 8h10" strokeLinecap="round" />
                      </svg>
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!loading && users.length === 0 && (
              <tr><td colSpan={5} className="py-2" style={{ color: "var(--muted)" }}>
                {query.trim()
                  ? "검색 결과 없음"
                  : "동기화된 사용자 없음 — [AD 전체 동기화]를 실행하세요"}
              </td></tr>
            )}
          </tbody>
        </table>
        {/* 바닥에 닿으면 다음 페이지를 부른다 / next page loads when this scrolls into view */}
        <div ref={sentinelRef} className="h-6 text-center text-xs"
             style={{ color: "var(--muted)" }} data-testid="AdminPage-adUsersSentinel">
          {loading ? "불러오는 중…" : hasMore ? "" : null}
        </div>
      </div>
      {error && (
        <p className="text-xs" style={{ color: "var(--error)" }}
           data-testid="AdminPage-adUsersError">{error}</p>
      )}
    </section>
  );
}
