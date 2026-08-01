"use client";

/** 파싱 지표·실패 목록 관리 화면 (계획 §2.2) / parse-rate metrics and failure list. */

import { useEffect, useState } from "react";

import { AppHeader } from "@/components/AppHeader";
import { fetchParseStats, fetchSnapshots, type ParseStats } from "@/lib/api";

export default function ParsingPage() {
  const [stats, setStats] = useState<ParseStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 인증 헤더가 붙는 공용 클라이언트 사용 — raw fetch는 auth ON에서 401
    fetchSnapshots()
      .then((body) => {
        const ready = body.items.find((s) => s.status === "ready");
        if (!ready) throw new Error("ready 스냅샷이 없습니다");
        return fetchParseStats(ready.id);
      })
      .then(setStats)
      .catch((e) => setError(e.message));
  }, []);

  let content: React.ReactNode = null;
  if (error) {
    content = (
      <p className="p-6" style={{ color: "var(--error)" }} data-testid="ParsingPage-errorText">
        {error}
      </p>
    );
  } else if (!stats) {
    content = <p className="p-6" style={{ color: "var(--muted)" }}>불러오는 중…</p>;
  }
  if (content) {
    return (
      <div className="flex h-screen flex-col overflow-hidden">
        <AppHeader />
        {content}
      </div>
    );
  }
  if (!stats) return null;

  const tiles: [string, number | string][] = [
    ["전체 뷰", stats.total_views],
    ["파싱 성공", stats.counts.ok ?? 0],
    ["부분 해석", stats.counts.partial ?? 0],
    ["미지원", stats.counts.unsupported ?? 0],
    ["파싱 실패", stats.counts.parse_failed ?? 0],
    ["정의 없음(권한)", stats.counts.no_definition ?? 0],
    ["성공률", stats.success_rate !== null ? `${(stats.success_rate * 100).toFixed(1)}%` : "—"],
  ];

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <AppHeader />
      <div className="scroll-area min-h-0 flex-1">
        <div className="mx-auto max-w-4xl p-6" data-testid="ParsingPage-root">
          <h1 className="erd-node__header mb-4 !border-0 !p-0">파싱 지표 — 스냅샷 #{stats.snapshot_id}</h1>
      <div className="mb-6 grid grid-cols-4 gap-3">
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded-lg border p-3"
               style={{ borderColor: "var(--hairline)" }}>
            <div className="text-xs" style={{ color: "var(--muted)" }}>{label}</div>
            <div className="text-xl">{value}</div>
          </div>
        ))}
      </div>

      <h2 className="mb-2 text-sm font-medium">격리된 뷰 (파싱 실패 · 미지원)</h2>
      <table className="w-full text-sm" data-testid="ParsingPage-failedTable">
        <thead>
          <tr className="border-b text-left" style={{ borderColor: "var(--hairline)" }}>
            <th className="py-1.5">뷰</th>
            <th>상태</th>
            <th>오류</th>
          </tr>
        </thead>
        <tbody>
          {stats.failed_views.map((v) => (
            <tr key={v.id} className="border-b" style={{ borderColor: "var(--border-light)" }}
                data-testid={`ParsingPage-failedRow-${v.id}`}>
              <td className="py-1.5 font-mono text-xs">{v.name}</td>
              <td><span className="badge badge--unresolved">{v.status}</span></td>
              <td className="text-xs" style={{ color: "var(--slate)" }}>{v.error ?? "—"}</td>
            </tr>
          ))}
          {stats.failed_views.length === 0 && (
            <tr><td className="py-2" style={{ color: "var(--muted)" }} colSpan={3}>없음</td></tr>
          )}
        </tbody>
      </table>
        </div>
      </div>
    </div>
  );
}
