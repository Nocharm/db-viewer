"use client";

/** 관리 콘솔 — 화이트리스트·AD 동기화 (sysadmin 전용). / whitelist and user-sync console. */

import { useEffect, useState } from "react";

import { AppHeader } from "@/components/AppHeader";
import { CollectPanel } from "@/components/admin/CollectPanel";
import { useMe } from "@/components/providers";
import { useElapsedSeconds } from "@/lib/use-elapsed";
import {
  addWhitelist,
  fetchUsers,
  fetchWhitelist,
  removeWhitelist,
  syncUsers,
  type AppUserEntry,
  type WhitelistEntry,
} from "@/lib/api";

export default function AdminPage() {
  const me = useMe();
  const [items, setItems] = useState<WhitelistEntry[]>([]);
  const [users, setUsers] = useState<AppUserEntry[]>([]);
  const [userFilter, setUserFilter] = useState("");
  const [loginId, setLoginId] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // AD 전체 동기화는 분 단위로 걸릴 수 있다 — 경과 표시 / full AD sync can take minutes
  const [syncing, setSyncing] = useState(false);
  const syncElapsed = useElapsedSeconds(syncing);

  // 화이트리스트와 AD 사용자는 별개 테이블 — 동기화 결과가 보이려면 둘 다 갱신해야 한다
  // the whitelist and AD users are separate tables; a sync only changes the latter
  const reload = () =>
    Promise.all([fetchWhitelist(), fetchUsers()])
      .then(([w, u]) => {
        setItems(w.items);
        setUsers(u.items);
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    if (me?.is_sysadmin || me?.auth_enabled === false) void reload();
  }, [me]);

  if (me && me.auth_enabled && !me.is_sysadmin) {
    return (
      <div className="flex h-screen flex-col overflow-hidden">
        <AppHeader />
        <p className="p-6" style={{ color: "var(--error)" }} data-testid="AdminPage-forbidden">
          시스템 관리자 전용 화면입니다.
        </p>
      </div>
    );
  }

  // 렌더 중 계산 — 파생 상태에 useEffect를 쓰지 않는다 / derived during render
  const whitelisted = new Set(items.map((item) => item.login_id));
  const filterText = userFilter.trim().toLowerCase();
  const visibleUsers = filterText
    ? users.filter((u) => `${u.login_id} ${u.name ?? ""} ${u.department ?? ""}`
        .toLowerCase().includes(filterText))
    : users;

  /** 작업 실행 → 메시지 표시 → 목록 갱신. task가 문자열을 반환하면 그 메시지를 쓴다. */
  const run = (task: () => Promise<unknown>, done: string) => {
    setError(null);
    task()
      .then((detail) => {
        setMessage(typeof detail === "string" ? detail : done);
        return reload();
      })
      .catch((e) => setError(e.message));
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <AppHeader />
      <div className="scroll-area min-h-0 flex-1">
        <div className="mx-auto max-w-3xl p-6" data-testid="AdminPage-root">
          <h1 className="mb-5 text-2xl font-bold tracking-tight" style={{ color: "var(--ink)" }}>
            관리 콘솔
          </h1>

      <CollectPanel />

      <section className="mb-6">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-medium">로그인 화이트리스트</h2>
          <button
            className="icon-button ml-auto"
            disabled={syncing}
            onClick={() => {
              setSyncing(true);
              run(async () => {
                try {
                  const summary = await syncUsers();
                  return `AD 동기화 — 스캔 ${summary.scanned} / 반영 ${summary.upserted} / `
                    + `제외 ${summary.excluded} / 정리 ${summary.purged}`;
                } finally {
                  setSyncing(false);
                }
              }, "AD 동기화 완료");
            }}
            data-testid="AdminPage-syncButton"
          >
            {syncing ? `동기화 중… ${syncElapsed}초` : "AD 전체 동기화"}
          </button>
        </div>

        <div className="mb-3 flex gap-2">
          <input
            className="flex-1 rounded border px-3 py-1.5 text-sm"
            style={{ borderColor: "var(--border-light)" }}
            placeholder="login_id (예: hong.gil)"
            value={loginId}
            onChange={(e) => setLoginId(e.target.value)}
            data-testid="AdminPage-loginIdInput"
          />
          <input
            className="flex-1 rounded border px-3 py-1.5 text-sm"
            style={{ borderColor: "var(--border-light)" }}
            placeholder="메모 (선택)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="AdminPage-noteInput"
          />
          <button
            className="btn-primary"
            onClick={() =>
              run(() => addWhitelist(loginId.trim(), note || undefined), "추가 완료")}
            disabled={!loginId.trim()}
            data-testid="AdminPage-addButton"
          >
            추가
          </button>
        </div>

        <table className="w-full text-sm" data-testid="AdminPage-whitelistTable">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--hairline)" }}>
              <th className="py-1.5">login_id</th><th>이름</th><th>메모</th>
              <th>등록자</th><th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.login_id} className="border-b"
                  style={{ borderColor: "var(--border-light)" }}
                  data-testid={`AdminPage-whitelistRow-${item.login_id}`}>
                <td className="py-1.5 font-mono text-xs">{item.login_id}</td>
                <td>{item.name ?? "—"}</td>
                <td className="text-xs" style={{ color: "var(--slate)" }}>{item.note ?? ""}</td>
                <td className="text-xs" style={{ color: "var(--muted)" }}>{item.added_by}</td>
                <td className="text-right">
                  <button
                    className="icon-button"
                    onClick={() => run(() => removeWhitelist(item.login_id), "삭제 완료")}
                    data-testid={`AdminPage-removeButton-${item.login_id}`}
                  >
                    삭제
                  </button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={5} className="py-2" style={{ color: "var(--muted)" }}>
                등록된 항목 없음
              </td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="mb-6" data-testid="AdminPage-adUsersSection">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-medium">AD 사용자</h2>
          <span className="badge badge--muted" data-testid="AdminPage-adUserCount">
            {users.length.toLocaleString()}
          </span>
          <input
            className="ml-auto w-56 rounded border px-3 py-1.5 text-sm"
            style={{ borderColor: "var(--border-light)" }}
            placeholder="이름·ID·부서 검색"
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value)}
            data-testid="AdminPage-userFilterInput"
          />
        </div>
        <p className="mb-2 text-xs" style={{ color: "var(--muted)" }}>
          AD 전체 동기화로 적재된 목록입니다. 로그인 허용은 위 화이트리스트가 결정합니다.
        </p>
        <table className="w-full text-sm" data-testid="AdminPage-adUsersTable">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--hairline)" }}>
              <th className="py-1.5">login_id</th><th>이름</th><th>부서</th>
              <th>이메일</th><th></th>
            </tr>
          </thead>
          <tbody>
            {visibleUsers.map((user) => (
              <tr key={user.login_id} className="border-b"
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
                    <span className="text-xs" style={{ color: "var(--rel-confirmed)" }}>
                      허용됨
                    </span>
                  ) : (
                    <button
                      className="icon-button"
                      onClick={() => run(
                        () => addWhitelist(user.login_id, user.department ?? undefined),
                        `${user.login_id} 허용 추가`,
                      )}
                      data-testid={`AdminPage-allowButton-${user.login_id}`}
                    >
                      허용 추가
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr><td colSpan={5} className="py-2" style={{ color: "var(--muted)" }}>
                동기화된 사용자 없음 — [AD 전체 동기화]를 실행하세요
              </td></tr>
            )}
            {users.length > 0 && visibleUsers.length === 0 && (
              <tr><td colSpan={5} className="py-2" style={{ color: "var(--muted)" }}>
                검색 결과 없음
              </td></tr>
            )}
          </tbody>
        </table>
      </section>

      {message && <p className="text-sm" style={{ color: "var(--rel-confirmed)" }}
                     data-testid="AdminPage-message">{message}</p>}
      {error && <p className="text-sm" style={{ color: "var(--error)" }}
                   data-testid="AdminPage-errorText">{error}</p>}
        </div>
      </div>
    </div>
  );
}
