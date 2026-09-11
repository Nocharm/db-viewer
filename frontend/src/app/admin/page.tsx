"use client";

/** 관리 콘솔 — 소스·수집 / 공개 범위 / AI 색인 / 사용자 네 탭 (sysadmin 전용). 탭은 URL
 * ?tab=과 동기화되고, 패널은 언마운트하지 않고 hidden으로 감춘다(입력한 관리 비밀번호와
 * 수집 잡 폴링이 탭을 오가도 살아 있어야 한다).
 * Admin console in four tabs; panels stay mounted so their state survives tab switches. */

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import { AppHeader } from "@/components/AppHeader";
import { AdUserList } from "@/components/admin/AdUserList";
import { AdminTabs, getAdminPanelId, getAdminTabId } from "@/components/admin/AdminTabs";
import { CollectPanel } from "@/components/admin/CollectPanel";
import { DataSourcePanel } from "@/components/admin/DataSourcePanel";
import { HiddenSchemaPanel } from "@/components/admin/HiddenSchemaPanel";
import { PreviewAllowlistPanel } from "@/components/admin/PreviewAllowlistPanel";
import { SourceSelector } from "@/components/SourceSelector";
import { useI18n } from "@/components/i18n";
import { useMe } from "@/components/providers";
import { buildAdminTabUrl, parseAdminTab, type AdminTabId } from "@/lib/admin-tabs";
import { useElapsedSeconds } from "@/lib/use-elapsed";
import {
  addWhitelist,
  fetchAiJob,
  fetchWhitelist,
  removeWhitelist,
  startEmbedIndex,
  syncUsers,
  type AiJobStatus,
  type WhitelistEntry,
} from "@/lib/api";

export default function AdminPage() {
  // useSearchParams()는 정적 렌더에서 Suspense 경계를 요구한다 (page.tsx와 같은 관용)
  return (
    <Suspense fallback={null}>
      <AdminConsole />
    </Suspense>
  );
}

function AdminConsole() {
  const { t } = useI18n();
  const me = useMe();
  const params = useSearchParams();
  // 초기 탭은 useSearchParams()에서, 이후 갱신은 history.replaceState — 이 state가 진실 소스
  // (Next 라우터를 거치지 않는 replaceState는 useSearchParams()에 반영되지 않는다)
  const [tab, setTab] = useState<AdminTabId>(() => parseAdminTab(params.get("tab")));
  const [items, setItems] = useState<WhitelistEntry[]>([]);
  // 값이 오르면 AD 목록이 첫 페이지부터 다시 읽는다 (동기화·허용 추가 후)
  const [adRefreshKey, setAdRefreshKey] = useState(0);
  // 미리보기 허용 목록은 소스별(PK가 (data_source_id, schema)) — 여기서 고른 소스를 따른다.
  // null은 사내 MSSQL(기본 소스), 소스가 하나뿐이면 SourceSelector가 스스로 숨는다.
  const [previewSourceId, setPreviewSourceId] = useState<number | null>(null);
  const [loginId, setLoginId] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // AD 전체 동기화는 분 단위로 걸릴 수 있다 — 경과 표시 / full AD sync can take minutes
  const [syncing, setSyncing] = useState(false);
  const syncElapsed = useElapsedSeconds(syncing);

  // 화이트리스트와 AD 사용자는 별개 테이블 — 동기화 결과가 보이려면 둘 다 갱신해야 한다
  // 임베딩 인덱싱 잡 폴링 상태 (사이클2 Task 8) — CollectPanel과 동일한 1.5초 폴링 관용
  const [embedJobId, setEmbedJobId] = useState<number | null>(null);
  const [embedJob, setEmbedJob] = useState<AiJobStatus | null>(null);
  const [embedStarting, setEmbedStarting] = useState(false);
  const [embedError, setEmbedError] = useState<string | null>(null);
  const embedBusy = embedStarting
    || (embedJob !== null && (embedJob.status === "queued" || embedJob.status === "running"));

  const reload = () =>
    fetchWhitelist()
      .then((w) => {
        setItems(w.items);
        setAdRefreshKey((n) => n + 1);
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    if (me?.is_sysadmin || me?.auth_enabled === false) void reload();
  }, [me]);

  useEffect(() => {
    if (embedJobId === null) return;
    const timer = setInterval(() => {
      fetchAiJob(embedJobId)
        .then((job) => {
          setEmbedJob(job);
          if (job.status === "done" || job.status === "failed") setEmbedJobId(null);
        })
        .catch((e) => {
          setEmbedError(e.message);
          setEmbedJobId(null);
        });
    }, 1500);
    return () => clearInterval(timer);
  }, [embedJobId]);

  const startEmbedIndexing = () => {
    setEmbedError(null);
    setEmbedStarting(true);
    startEmbedIndex()
      .then((res) => setEmbedJobId(res.job_id))
      .catch((e) => setEmbedError(e.message))
      .finally(() => setEmbedStarting(false));
  };

  const selectTab = (next: AdminTabId) => {
    setTab(next);
    window.history.replaceState(
      null, "", buildAdminTabUrl(window.location.pathname, window.location.search, next),
    );
  };

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

  /** 탭 패널 공통 속성 — 활성 탭만 보이고 나머지는 hidden(마운트 유지) / shared panel wiring */
  const panelProps = (id: AdminTabId) => ({
    id: getAdminPanelId(id),
    role: "tabpanel",
    "aria-labelledby": getAdminTabId(id),
    className: "tab-panel",
    hidden: tab !== id,
    "data-testid": `AdminPage-panel-${id}`,
  });

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <AppHeader />
      <div className="scroll-area min-h-0 flex-1">
        <div className="mx-auto max-w-3xl p-6" data-testid="AdminPage-root">
          <h1 className="mb-4 text-2xl font-bold tracking-tight" style={{ color: "var(--ink)" }}>
            관리 콘솔
          </h1>

          <AdminTabs active={tab} onChange={selectTab} />

          {/* 소스가 없으면 나머지 관리 기능이 전부 무의미해서 첫 탭 */}
          <div {...panelProps("sources")}>
            <DataSourcePanel />
            <CollectPanel />
          </div>

          <div {...panelProps("access")}>
            <div className="mb-2 flex items-center gap-2">
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                미리보기 허용 대상 소스
              </span>
              <SourceSelector value={previewSourceId} onChange={setPreviewSourceId} />
            </div>
            <PreviewAllowlistPanel sourceId={previewSourceId} />
            <HiddenSchemaPanel />
          </div>

          <div {...panelProps("ai")}>
            <section className="mb-6" data-testid="AdminPage-embedIndexSection">
              <div className="mb-1 flex items-center gap-2">
                <h2 className="text-sm font-medium">{t("admin.embedIndexTitle")}</h2>
              </div>
              <p className="mb-3 text-xs" style={{ color: "var(--muted)" }}>
                {t("admin.embedIndexHint")}
              </p>
              <button
                className="btn-primary mb-3"
                disabled={embedBusy}
                onClick={startEmbedIndexing}
                data-testid="AdminPage-embedIndexButton"
              >
                {embedBusy ? t("admin.embedIndexRunning") : t("admin.embedIndexButton")}
              </button>

              {embedJob && (embedJob.status === "queued" || embedJob.status === "running")
                && embedJob.progress_total > 0 && (
                <div data-testid="AdminPage-embedIndexProgress">
                  <p className="mb-1 text-xs" style={{ color: "var(--body-text)" }}>
                    {t("admin.embedIndexProgress")} ({embedJob.progress_done}/{embedJob.progress_total})
                  </p>
                  <div className="rate-bar !w-full">
                    <div className="rate-bar__fill transition-all duration-300 ease-in-out"
                         style={{
                           width: `${Math.round((embedJob.progress_done / embedJob.progress_total) * 100)}%`,
                         }} />
                  </div>
                </div>
              )}

              {embedJob && embedJob.status === "done" && embedJob.result && "indexed" in embedJob.result && (
                <p className="text-sm" style={{ color: "var(--rel-confirmed)" }}
                   data-testid="AdminPage-embedIndexResult">
                  {t("admin.embedIndexDone")
                    .replace("{indexed}", String(embedJob.result.indexed))
                    .replace("{skipped}", String(embedJob.result.skipped))
                    .replace("{remaining}", String(embedJob.result.remaining))}
                </p>
              )}

              {embedJob && embedJob.status === "failed" && (
                <p className="text-sm" style={{ color: "var(--error)" }}
                   data-testid="AdminPage-embedIndexErrorText">
                  {t("admin.embedIndexFailed")} — {embedJob.error}
                </p>
              )}

              {embedError && (
                <p className="text-sm" style={{ color: "var(--error)" }}
                   data-testid="AdminPage-embedIndexStartErrorText">
                  {embedError}
                </p>
              )}
            </section>
          </div>

          <div {...panelProps("users")}>
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
                          className="icon-button row-action"
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

            <AdUserList
              whitelisted={whitelisted}
              refreshKey={adRefreshKey}
              onAllow={(user) => run(
                () => addWhitelist(user.login_id, user.department ?? undefined),
                `${user.login_id} 허용 추가`,
              )}
            />

            {message && <p className="text-sm" style={{ color: "var(--rel-confirmed)" }}
                           data-testid="AdminPage-message">{message}</p>}
            {error && <p className="text-sm" style={{ color: "var(--error)" }}
                         data-testid="AdminPage-errorText">{error}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
