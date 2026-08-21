"use client";

/** 업무 Postgres 화면 — 소스 선택 + 테이블 목록 + (열었을 때) 아래 미리보기 섹션.
 *
 * 이 소스들은 카탈로그에 수집하지 않는다 — 목록도 값도 그때그때 원본에 묻는다. 그래서
 * ERD·조인 검증 대상이 아니고, 화면도 "고른 테이블의 값을 본다"까지만 한다. 연결 등록은
 * 관리 콘솔이 담당하고 여기서는 등록된 것을 고르기만 한다. 미리보기는 테이블 화면·ERD와
 * 같은 PreviewSection을 아래 섹션으로 붙여 쓴다.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AppHeader } from "@/components/AppHeader";
import { PreviewSection } from "@/components/browser/PreviewSection";
import { useI18n } from "@/components/i18n";
import { DatabaseIcon, LockIcon, SampleIcon, SearchIcon } from "@/components/icons";
import {
  fetchPgPreview, fetchPgStatus, fetchPgTables,
  type PgSourceSummary, type PgTable,
} from "@/lib/api";
import { getPgTabId } from "@/lib/pg-tabs";
import { usePreviewTabs, type PreviewFetcher } from "@/lib/use-preview-tabs";

// 한 번에 그리는 행 수 상한 — 목록이 커도 첫 렌더가 느려지지 않게 (검색으로 좁힌다)
const MAX_ROWS = 300;

export default function PgSourcePage() {
  const { t } = useI18n();
  const [sources, setSources] = useState<PgSourceSummary[]>([]);
  const [active, setActive] = useState<PgSourceSummary | null>(null);
  const [tables, setTables] = useState<PgTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  // 탭 id는 이 화면이 정한다 — 객체 id가 없는 소스라 (소스, 테이블)을 id로 대신 붙인다
  const byId = useRef(new Map<number, { source: string; table: PgTable }>());

  const fetchPreview = useCallback<PreviewFetcher>((id, filters, limit) => {
    const entry = byId.current.get(id);
    if (!entry) return Promise.reject(new Error(`unknown preview tab: ${id}`));
    return fetchPgPreview(entry.source, entry.table.schema, entry.table.name, filters, limit);
  }, []);
  const preview = usePreviewTabs({ fetchPreview, dialect: "pg" });

  useEffect(() => {
    fetchPgStatus()
      .then((res) => {
        setSources(res.sources);
        setActive(res.sources[0] ?? null);
        if (res.sources.length === 0) setLoading(false);
      })
      .catch((e: Error) => { setError(e.message); setLoading(false); });
  }, []);

  // 소스를 바꾸면 그 소스의 목록을 새로 읽는다 (탭은 유지 — 소스를 오가며 비교할 수 있다)
  useEffect(() => {
    if (!active) return;
    setLoading(true);
    setTables([]);
    fetchPgTables(active.slug)
      .then((res) => {
        setTables(res.items);
        res.items.forEach((table, index) => {
          byId.current.set(getPgTabId(active.slug, index), { source: active.slug, table });
        });
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [active]);

  const allowed = useMemo(
    () => new Set(active?.allowed_schemas ?? []), [active]);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    const rows = tables.map((table, index) => [index, table] as const);
    return term
      ? rows.filter(([, row]) => `${row.schema}.${row.name}`.toLowerCase().includes(term))
      : rows;
  }, [query, tables]);

  const openPreview = (index: number, table: PgTable) => {
    if (!active) return;
    preview.open(getPgTabId(active.slug, index), `${table.schema}.${table.name}`);
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
            <section className="card p-4" data-testid="PgPage-sourceCard">
              <div className="flex items-center gap-2">
                <span style={{ color: "var(--action-blue)" }}><DatabaseIcon size={16} /></span>
                <h1 className="text-base font-semibold" style={{ color: "var(--ink)" }}>
                  {t("pg.title")}
                </h1>
                {active && (
                  <span className="badge badge--muted ml-auto" data-testid="PgPage-tableCount">
                    {t("pg.tableCount").replace("{n}", tables.length.toLocaleString())}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs leading-snug" style={{ color: "var(--slate)" }}>
                {t("pg.subtitle")}
              </p>

              {sources.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5" data-testid="PgPage-sourceTabs">
                  {sources.map((source) => {
                    const on = source.slug === active?.slug;
                    return (
                      <button
                        key={source.slug}
                        className="pressable rounded border px-2.5 py-1 text-sm"
                        style={on
                          ? { borderColor: "var(--action-blue)", color: "var(--action-blue)",
                              fontWeight: 500 }
                          : { borderColor: "var(--hairline)", color: "var(--slate)" }}
                        onClick={() => { setActive(source); setQuery(""); }}
                        data-testid={`PgPage-sourceTab-${source.slug}`}
                      >
                        {source.label}
                        <span className="ml-1.5 font-mono text-xs"
                              style={{ color: "var(--muted)" }}>{source.database}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {sources.length === 0 && !error && (
                <p className="mt-2 text-sm" style={{ color: "var(--error)" }}
                   data-testid="PgPage-noSourcesNote">
                  {t("pg.noSources")}
                </p>
              )}
              {(error || preview.error) && (
                <p className="mt-2 text-sm" style={{ color: "var(--error)" }}
                   data-testid="PgPage-errorText">
                  {error ?? preview.error}
                </p>
              )}
            </section>

            {active && (
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
                  {visible.slice(0, MAX_ROWS).map(([index, table]) => {
                    const qname = `${table.schema}.${table.name}`;
                    const unlocked = allowed.has(table.schema);
                    return (
                      <li key={qname}
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
                          title={unlocked ? undefined : t("pg.lockedHint")}
                          onClick={() => openPreview(index, table)}
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
                      {loading ? t("common.loading") : t("pg.empty")}
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
