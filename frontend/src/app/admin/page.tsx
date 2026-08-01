"use client";

/** 관리 콘솔 — 화이트리스트·AD 동기화 (sysadmin 전용). / whitelist and user-sync console. */

import { useEffect, useState } from "react";

import { AppHeader } from "@/components/AppHeader";
import { CollectPanel } from "@/components/admin/CollectPanel";
import { useMe } from "@/components/providers";
import {
  addWhitelist,
  fetchWhitelist,
  removeWhitelist,
  syncUsers,
  type WhitelistEntry,
} from "@/lib/api";

export default function AdminPage() {
  const me = useMe();
  const [items, setItems] = useState<WhitelistEntry[]>([]);
  const [loginId, setLoginId] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () =>
    fetchWhitelist().then((r) => setItems(r.items)).catch((e) => setError(e.message));

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

  const run = (task: () => Promise<unknown>, done: string) => {
    setError(null);
    task()
      .then(() => {
        setMessage(done);
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
            onClick={() =>
              run(async () => {
                const summary = await syncUsers();
                setMessage(
                  `AD 동기화 — 스캔 ${summary.scanned} / 반영 ${summary.upserted} / ` +
                  `제외 ${summary.excluded} / 정리 ${summary.purged}`,
                );
              }, "AD 동기화 완료")}
            data-testid="AdminPage-syncButton"
          >
            AD 전체 동기화
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

      {message && <p className="text-sm" style={{ color: "var(--rel-confirmed)" }}
                     data-testid="AdminPage-message">{message}</p>}
      {error && <p className="text-sm" style={{ color: "var(--error)" }}
                   data-testid="AdminPage-errorText">{error}</p>}
        </div>
      </div>
    </div>
  );
}
