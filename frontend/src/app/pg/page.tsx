"use client";

/** 업무 Postgres 소스 화면 — 테이블 목록 + (열었을 때) 아래 미리보기 섹션.
 *
 * 이 소스는 카탈로그에 수집하지 않는다 — 목록도 값도 그때그때 원본에 묻는다. 그래서
 * ERD·조인 검증 대상이 아니고, 화면도 "고른 테이블의 값을 본다"까지만 한다. 미리보기는
 * 테이블 화면·ERD와 같은 PreviewSection을 아래 섹션으로 붙여 쓴다.
 * The business Postgres browser: a live table list and the shared preview section.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AppHeader } from "@/components/AppHeader";
import { PreviewSection } from "@/components/browser/PreviewSection";
import { useI18n } from "@/components/i18n";
import { DatabaseIcon, LockIcon, SampleIcon, SearchIcon } from "@/components/icons";
import { fetchPgStatus, fetchPgTables, fetchPgPreview, type PgStatus, type PgTable }
  from "@/lib/api";
import { usePreviewTabs, type PreviewFetcher } from "@/lib/use-preview-tabs";

// 한 번에 그리는 행 수 상한 — 목록이 커도 첫 렌더가 느려지지 않게 (검색으로 좁힌다)
const MAX_ROWS = 300;

export default function PgSourcePage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<PgStatus | null>(null);
  const [tables, setTables] = useState<PgTable[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  // 탭 id는 이 화면이 정한다 — 객체 id가 없는 소스라 목록 순서로 매긴다
  const byId = useRef(new Map<number, PgTable>());

  const fetchPreview = useCallback<PreviewFetcher>((id, filters, limit) => {
    const table = byId.current.get(id);
    if (!table) return Promise.reject(new Error(`unknown preview tab: ${id}`));
    return fetchPgPreview(table.schema, table.name, filters, limit);
  }, []);
  const preview = usePreviewTabs({ fetchPreview, dialect: "pg" });

  useEffect(() => {
    fetchPgStatus()
      .then((res) => {
        setStatus(res);
        return res.enabled ? fetchPgTables() : { items: [], total: 0 };
      })
      .then((res) => {
        byId.current = new Map(res.items.map((table, index) => [index + 1, table]));
        setTables(res.items);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const allowed = useMemo(() => new Set(status?.allowed_schemas ?? []), [status]);

  // 탭 id = 목록 순번 — byId(미리보기 조회용)와 같은 규칙이라 둘이 어긋나지 않는다
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    const rows = tables.map((table, index) => [index + 1, table] as const);
    return term
      ? rows.filter(([, row]) => `${row.schema}.${row.name}`.toLowerCase().includes(term))
      : rows;
  }, [query, tables]);

  const openPreview = (id: number, table: PgTable) => {
    preview.open(id, `${table.schema}.${table.name}`);
    // 섹션이 붙은 다음 프레임에 내려간다 — ERD·조인 검증과 같은 왕복 문법
    setTimeout(() => previewRef.current?.scrollIntoView(
      { behavior: "smooth", block: "start" }), 60);
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <AppHeader />
      <div ref={scrollRef} className="scroll-area min-h-0 flex-1">
        <div className="flex h-full flex-col">
          <main className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-3 p-4"
                data-testid="PgPage-root">
            <section className="card p-4" data-testid="PgPage-statusCard">
              <div className="flex items-center gap-2">
                <span style={{ color: "var(--action-blue)" }}><DatabaseIcon size={16} /></span>
                <h1 className="text-base font-semibold" style={{ color: "var(--ink)" }}>
                  {status?.label ?? t("pg.title")}
                </h1>
                {status?.connection && (
                  <span className="font-mono text-xs" style={{ color: "var(--muted)" }}
                        data-testid="PgPage-connection">
                    {status.connection.user}@{status.connection.host}
                    :{status.connection.port}/{status.connection.database}
                  </span>
                )}
                {status?.enabled && (
                  <span className="badge badge--muted ml-auto" data-testid="PgPage-tableCount">
                    {t("pg.tableCount").replace("{n}", tables.length.toLocaleString())}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs leading-snug" style={{ color: "var(--slate)" }}>
                {t("pg.subtitle")}
              </p>
              {status?.enabled === false && (
                <p className="mt-2 text-sm" style={{ color: "var(--error)" }}
                   data-testid="PgPage-disabledNote">
                  {t("pg.disabled")}
                </p>
              )}
              {(error || preview.error) && (
                <p className="mt-2 text-sm" style={{ color: "var(--error)" }}
                   data-testid="PgPage-errorText">
                  {error ?? preview.error}
                </p>
              )}
            </section>

            {status?.enabled && (
              <section className="card flex min-h-0 flex-1 flex-col p-4"
                       data-testid="PgPage-tableCard">
                <div className="mb-2 flex items-center gap-2">
                  <span style={{ color: "var(--muted)" }}><SearchIcon size={13} /></span>
                  <input
                    className="w-72 rounded border bg-transparent px-2 py-1 text-sm outline-none focus:border-[var(--focus-blue)]"
                    style={{ borderColor: "var(--hairline)", color: "var(--ink)" }}
                    placeholder={t("pg.searchPlaceholder")}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    data-testid="PgPage-searchInput"
                  />
                  <span className="ml-auto text-xs" style={{ color: "var(--muted)" }}>
                    {t("pg.shownOf")
                      .replace("{shown}", String(Math.min(visible.length, MAX_ROWS)))
                      .replace("{total}", String(tables.length))}
                  </span>
                </div>

                <ul className="scroll-area min-h-0 flex-1 overflow-y-auto"
                    data-testid="PgPage-tableList">
                  {visible.slice(0, MAX_ROWS).map(([id, table]) => {
                    const qname = `${table.schema}.${table.name}`;
                    const unlocked = allowed.has(table.schema);
                    return (
                      <li key={id}
                          className="flex items-center gap-2 border-b py-1.5"
                          style={{ borderColor: "var(--border-light)" }}
                          data-testid={`PgPage-tableRow-${qname}`}>
                        <span className="min-w-0 flex-1 truncate font-mono text-sm"
                              style={{ color: "var(--ink)" }}>
                          <span style={{ color: "var(--muted)" }}>{table.schema}.</span>
                          {table.name}
                        </span>
                        {table.type === "view" && <span className="badge badge--muted">view</span>}
                        <span className="w-28 text-right font-mono text-xs tabular-nums"
                              style={{ color: "var(--stat-ink)" }}>
                          {table.row_estimate === null
                            ? t("pg.rowUnknown")
                            : t("pg.rowEstimate")
                              .replace("{n}", table.row_estimate.toLocaleString())}
                        </span>
                        <button
                          className="icon-button"
                          disabled={!unlocked}
                          title={unlocked ? undefined
                            : t("pg.lockedHint").replace("{key}", `pg:${table.schema}`)}
                          onClick={() => openPreview(id, table)}
                          data-testid={`PgPage-previewButton-${qname}`}
                        >
                          {unlocked
                            ? <SampleIcon size={11} className="mr-1 inline-block align-middle" />
                            : <LockIcon size={11} className="mr-1 inline-block align-middle" />}
                          {unlocked ? t("pg.viewValues") : t("pg.locked")}
                        </button>
                      </li>
                    );
                  })}
                  {visible.length === 0 && (
                    <li className="py-2 text-sm" style={{ color: "var(--muted)" }}
                        data-testid="PgPage-emptyState">
                      {t("pg.empty")}
                    </li>
                  )}
                </ul>
              </section>
            )}
          </main>
        </div>

        {preview.tabs.length > 0 && (
          <div ref={previewRef} className="px-4 pb-4 pt-1" data-testid="PgPage-previewSection">
            <PreviewSection
              tabs={preview.tabs}
              activeId={preview.activeId}
              splitId={preview.splitId}
              onActivate={preview.setActiveId}
              onClose={preview.close}
              onSplitPick={preview.setSplitId}
              onRefetch={preview.refetch}
              onPatch={preview.patch}
              onJumpToTop={() => scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
            />
          </div>
        )}
      </div>
    </div>
  );
}
