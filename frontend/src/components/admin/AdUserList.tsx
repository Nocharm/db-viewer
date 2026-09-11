"use client";

/** AD 동기 사용자 목록 — 서버 검색 + 무한 스크롤. / AD user list with server search and paging. */

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchUsers, type AppUserEntry } from "@/lib/api";
import { CheckIcon, PlusIcon, SearchIcon, UsersIcon, WarningIcon } from "@/components/icons";

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

/** 아바타 이니셜 — login_id 첫 글자 (이름은 동기화 전엔 없을 수 있다) */
export function getInitial(loginId: string): string {
  return (loginId.trim()[0] ?? "?").toUpperCase();
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

  const isEmpty = !loading && users.length === 0;

  return (
    <section className="mb-6" data-testid="AdminPage-adUsersSection">
      <div className="sec-head">
        <span className="sec-head__tile"><SearchIcon size={14} /></span>
        <h2 className="sec-head__title">AD 사용자</h2>
        <span className="cnt-pill" data-testid="AdminPage-adUserCount">
          {users.length.toLocaleString()} / {total.toLocaleString()}
        </span>
        <div className="sec-head__right">
          <input
            className="ctl-field w-56"
            placeholder="이름·ID·부서 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="AdminPage-userFilterInput"
          />
        </div>
      </div>
      <p className="sec-desc">
        검색은 동기화된 전체 인원을 대상으로 합니다. 로그인 허용은 위 화이트리스트가 결정합니다.
      </p>

      {isEmpty ? (
        <div className="empty-state" data-testid="AdminPage-adUsersEmptyState">
          <UsersIcon size={22} />
          <span>{query.trim() ? "검색 결과 없음" : "동기화된 사용자 없음 — [AD 전체 동기화]를 실행하세요"}</span>
        </div>
      ) : (
        <div className="card">
          <div className="scroll-area max-h-96 overflow-y-auto" data-testid="AdminPage-adUsersScroll">
            <table className="data-table" data-testid="AdminPage-adUsersTable">
              <colgroup>
                <col style={{ width: "28%" }} /><col style={{ width: "16%" }} />
                <col style={{ width: "18%" }} /><col /><col style={{ width: "96px" }} />
              </colgroup>
              <thead>
                <tr><th>login_id</th><th>이름</th><th>부서</th><th>이메일</th><th></th></tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.login_id} className="reveal-host"
                      data-testid={`AdminPage-adUserRow-${user.login_id}`}>
                    <td>
                      <span className="avatar">{getInitial(user.login_id)}</span>
                      <span className="font-mono text-xs" style={{ color: "var(--ink)" }}>{user.login_id}</span>
                    </td>
                    <td>{user.name ?? "—"}</td>
                    <td className="text-xs" style={{ color: "var(--slate)" }}>{user.department ?? "—"}</td>
                    <td className="text-xs" style={{ color: "var(--slate)" }}>{user.email ?? "—"}</td>
                    <td className="text-right">
                      {whitelisted.has(user.login_id) ? (
                        <span className="badge badge--ok badge--plain" title="로그인 허용됨">
                          <CheckIcon size={11} />허용됨
                        </span>
                      ) : (
                        // 평소엔 숨고 행 호버·키보드 포커스에서만 보인다 / hover- and focus-revealed
                        <button
                          className="icon-button reveal-action"
                          title={`${user.login_id} 로그인 허용 추가`}
                          aria-label={`${user.login_id} 로그인 허용 추가`}
                          onClick={() => onAllow(user)}
                          data-testid={`AdminPage-allowButton-${user.login_id}`}
                        >
                          <PlusIcon size={13} />허용
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* 바닥에 닿으면 다음 페이지를 부른다 / next page loads when this scrolls into view */}
            <div ref={sentinelRef} className="h-6 text-center text-xs"
                 style={{ color: "var(--muted)" }} data-testid="AdminPage-adUsersSentinel">
              {loading ? "불러오는 중…" : hasMore ? "" : null}
            </div>
          </div>
        </div>
      )}
      {error && (
        <div className="banner banner--err mt-3" data-testid="AdminPage-adUsersError">
          <WarningIcon size={15} /><span>{error}</span>
        </div>
      )}
    </section>
  );
}
