"use client";

/** 파싱 지표·실패 목록 관리 화면 (계획 §2.2) / parse-rate metrics and failure list. */

import { useEffect, useState } from "react";
import Link from "next/link";

import { AppHeader } from "@/components/AppHeader";
import { useI18n } from "@/components/i18n";
import {
  fetchParseStats,
  fetchSnapshots,
  MANAGED_MSSQL_SOURCE_ID,
  type ParseStats,
} from "@/lib/api";

export default function ParsingPage() {
  const { t } = useI18n();
  const [stats, setStats] = useState<ParseStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 인증 헤더가 붙는 공용 클라이언트 사용 — raw fetch는 auth ON에서 401.
    // 소스를 사내 MSSQL로 고정한다: 뷰 파싱(Phase 2)은 MSSQL 소스에서만 돈다(스펙 §2.3).
    // 스냅샷 id는 전 소스 공통 시퀀스라, 소스를 안 걸면 PG/SQLite 스냅샷을 한 번이라도
    // 수집한 순간 그쪽이 "최신 ready"가 되어 parse_status가 전부 NULL인 빈 대시보드가
    // 오류 없이 뜬다 — 사용자가 MSSQL을 보고 있는 동안에도 그렇다.
    // / pinned to the managed MSSQL source: view parsing only runs there, and snapshot
    //   ids are one global sequence, so an unscoped "latest ready" silently goes blank
    fetchSnapshots(MANAGED_MSSQL_SOURCE_ID)
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
    content = <p className="p-6" style={{ color: "var(--muted)" }}>{t("common.loading")}</p>;
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

  // 위험 지표는 값이 있을 때만 에러색 — 0이면 조용히 / danger color only when nonzero
  const tiles: { label: string; value: number; danger?: boolean }[] = [
    { label: t("parsing.totalViews"), value: stats.total_views },
    { label: t("parsing.ok"), value: stats.counts.ok ?? 0 },
    { label: t("parsing.partial"), value: stats.counts.partial ?? 0 },
    { label: t("parsing.unsupported"), value: stats.counts.unsupported ?? 0, danger: true },
    { label: t("parsing.failed"), value: stats.counts.parse_failed ?? 0, danger: true },
    { label: t("parsing.noDefinition"), value: stats.counts.no_definition ?? 0 },
  ];

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <AppHeader />
      <div className="scroll-area min-h-0 flex-1">
        <div className="mx-auto max-w-4xl p-6" data-testid="ParsingPage-root">
          <h1 className="mb-5 text-2xl font-bold tracking-tight" style={{ color: "var(--ink)" }}>
            {t("parsing.title")}{" "}
            <span style={{ color: "var(--muted)" }}>— {t("parsing.snapshot")} #{stats.snapshot_id}</span>
          </h1>
      <div className="mb-6 grid grid-cols-4 gap-3">
        {/* 히어로 스탯 — 성공률이 첫 시선. row-span-3 = 타일 6개(2열×3행)와 맞물려
            빈 칸 없는 직사각 그리드가 된다 / success rate hero; 3 rows complete the grid */}
        <div className="card col-span-2 row-span-3 flex flex-col justify-center p-5"
             data-testid="ParsingPage-successRateTile">
          <div className="mb-2 text-xs font-semibold uppercase tracking-widest"
               style={{ color: "var(--muted)" }}>
            {t("parsing.successRate")}
          </div>
          <div className="stat-number" style={{ fontSize: 56, letterSpacing: "-1.5px" }}>
            {stats.success_rate !== null ? `${(stats.success_rate * 100).toFixed(1)}%` : "—"}
          </div>
        </div>
        {tiles.map(({ label, value, danger }) => (
          <div key={label} className="card p-4">
            <div className="mb-1.5 text-xs" style={{ color: "var(--muted)" }}>{label}</div>
            <div className={`stat-number ${danger && value > 0 ? "stat-number--danger" : "stat-number--plain"}`}
                 style={{ fontSize: 24 }}>
              {value}
            </div>
          </div>
        ))}
      </div>

      <h2 className="mb-2 text-sm font-medium">{t("parsing.isolated")}</h2>
      <table className="w-full text-sm" data-testid="ParsingPage-failedTable">
        <thead>
          <tr className="border-b text-left" style={{ borderColor: "var(--hairline)" }}>
            <th className="py-1.5">{t("parsing.view")}</th>
            <th>{t("parsing.status")}</th>
            <th>{t("parsing.error")}</th>
          </tr>
        </thead>
        <tbody>
          {stats.failed_views.map((v) => (
            <tr key={v.id} className="border-b" style={{ borderColor: "var(--border-light)" }}
                data-testid={`ParsingPage-failedRow-${v.id}`}>
              {/* 이름 → 테이블 브라우저 딥링크 — 문제를 본 자리에서 바로 조사하러 갈 수
                  있어야 한다(막다른 목록 금지) / dead-end list fixed with a browser link */}
              <td className="py-1.5 font-mono text-xs">
                <Link href={`/?table=${v.id}`}
                      className="pressable -mx-1 rounded px-1 underline-offset-2 hover:underline"
                      style={{ color: "var(--action-blue)" }}
                      data-testid={`ParsingPage-failedLink-${v.id}`}>
                  {v.name}
                </Link>
              </td>
              <td><span className="badge badge--unresolved">{v.status}</span></td>
              <td className="text-xs" style={{ color: "var(--slate)" }}>{v.error ?? "—"}</td>
            </tr>
          ))}
          {stats.failed_views.length === 0 && (
            <tr><td className="py-2" style={{ color: "var(--muted)" }} colSpan={3}>{t("common.none")}</td></tr>
          )}
        </tbody>
      </table>
        </div>
      </div>
    </div>
  );
}
