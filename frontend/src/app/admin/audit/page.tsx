"use client";

/** 감사 로그 — 노출·권한을 바꾼 조작의 이력. / audit trail for exposure and access changes. */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { AppHeader } from "@/components/AppHeader";
import { useMe } from "@/components/providers";
import { fetchAuditLog, type AuditEntry } from "@/lib/api";

const PAGE_SIZE = 100;

// 코드 그대로는 무슨 조작인지 안 읽힌다 — 목록에 없는 action은 코드를 그대로 보여준다
// (새 action이 생겨도 화면이 비지 않게) / unknown actions fall back to the raw code
const ACTION_LABELS: Record<string, string> = {
  whitelist_add: "로그인 화이트리스트 등록",
  whitelist_remove: "로그인 화이트리스트 해제",
  preview_allow_add: "미리보기 허용 등록",
  preview_allow_remove: "미리보기 허용 해제",
  hidden_schema_render_set: "감춘 스키마 표시 토글",
  table_preview: "테이블 미리보기 (실값 반출)",
  join_preview: "조인 미리보기 (실값 반출)",
  relation_confirm: "관계 확정",
  login: "로그인",
};

export default function AuditPage() {
  const me = useMe();
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [action, setAction] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchAuditLog({ action: action || undefined, limit: PAGE_SIZE, offset })
      .then((res) => {
        setItems(res.items);
        setActions(res.actions);
        setTotal(res.total);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [action, offset]);

  useEffect(() => { load(); }, [load]);

  if (!me?.is_sysadmin) {
    return (
      <div className="flex h-screen flex-col">
        <AppHeader />
        <p className="p-6 text-sm" style={{ color: "var(--error)" }}
           data-testid="AuditPage-forbidden">
          관리자만 볼 수 있습니다.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <AppHeader />
      <div className="scroll-area surface-muted min-h-0 flex-1">
        <div className="mx-auto max-w-5xl p-6">
          <div className="mb-1 flex items-center gap-2">
            <h1 className="text-base font-semibold">감사 로그</h1>
            <span className="badge badge--muted" data-testid="AuditPage-total">
              {total.toLocaleString()}
            </span>
            <Link href="/admin" className="pressable ml-auto rounded px-2.5 py-1 text-sm"
                  style={{ color: "var(--action-blue)" }}
                  data-testid="AuditPage-backLink">
              관리 콘솔로
            </Link>
          </div>
          <p className="mb-3 text-xs" style={{ color: "var(--muted)" }}>
            노출 범위·접근 권한을 바꾼 조작과 실제 값이 화면으로 나간 기록이 함께 쌓입니다.
            최신순이며 수정·삭제 경로는 없습니다.
          </p>

          <div className="mb-3 flex items-center gap-2">
            <select
              className="rounded border px-3 py-1.5 text-sm"
              style={{ borderColor: "var(--border-light)" }}
              value={action}
              onChange={(e) => { setAction(e.target.value); setOffset(0); }}
              data-testid="AuditPage-actionFilter"
            >
              <option value="">전체 동작</option>
              {actions.map((code) => (
                <option key={code} value={code}>{ACTION_LABELS[code] ?? code}</option>
              ))}
            </select>
            <button className="icon-button" onClick={load} disabled={loading}
                    data-testid="AuditPage-refreshButton">
              {loading ? "불러오는 중…" : "새로고침"}
            </button>
          </div>

          <table className="w-full text-sm" data-testid="AuditPage-table">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--hairline)" }}>
                <th className="w-44 py-1.5">시각</th>
                <th className="w-56">동작</th>
                <th>대상</th>
                <th className="w-36">요청자</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b align-top"
                    style={{ borderColor: "var(--border-light)" }}
                    data-testid={`AuditPage-row-${item.id}`}>
                  <td className="py-1.5 text-xs" style={{ color: "var(--muted)" }}>
                    {new Date(item.requested_at).toLocaleString()}
                  </td>
                  <td className="text-xs">{ACTION_LABELS[item.action] ?? item.action}</td>
                  <td className="break-all font-mono text-xs"
                      style={{ color: "var(--slate)" }}>
                    {item.detail}
                  </td>
                  <td className="text-xs" style={{ color: "var(--muted)" }}>
                    {item.requested_by}
                  </td>
                </tr>
              ))}
              {items.length === 0 && !loading && (
                <tr><td colSpan={4} className="py-2" style={{ color: "var(--muted)" }}
                        data-testid="AuditPage-emptyState">
                  기록 없음
                </td></tr>
              )}
            </tbody>
          </table>

          {total > PAGE_SIZE && (
            <div className="mt-3 flex items-center gap-2">
              <button className="icon-button" disabled={offset === 0}
                      onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                      data-testid="AuditPage-prevButton">
                이전
              </button>
              <span className="text-xs" style={{ color: "var(--muted)" }}
                    data-testid="AuditPage-range">
                {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} / {total.toLocaleString()}
              </span>
              <button className="icon-button" disabled={offset + PAGE_SIZE >= total}
                      onClick={() => setOffset(offset + PAGE_SIZE)}
                      data-testid="AuditPage-nextButton">
                다음
              </button>
            </div>
          )}

          {error && (
            <p className="mt-2 text-sm" style={{ color: "var(--error)" }}
               data-testid="AuditPage-error">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}
