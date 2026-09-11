"use client";

/** 관리 콘솔 — 소스·수집 / 공개 범위 / AI 색인 / 사용자 / 감사 로그 다섯 탭 (sysadmin 전용).
 * 탭은 URL ?tab=과 동기화되고, 패널은 언마운트하지 않고 hidden으로 감춘다(잠금 바의 관리
 * 비밀번호와 수집 잡 폴링이 탭을 오가도 살아 있어야 한다). 관리 비밀번호는 이 페이지가 하나로
 * 쥐고 소스·공개 범위 패널에 내려보낸다.
 * Admin console in five tabs; panels stay mounted so their state survives tab switches; the
 * admin password lives here and feeds the lock bar plus the panels that need it. */

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import { AppHeader } from "@/components/AppHeader";
import { AdUserList, getInitial } from "@/components/admin/AdUserList";
import { AdminLockBar } from "@/components/admin/AdminLockBar";
import { AdminTabs, getAdminPanelId, getAdminTabId } from "@/components/admin/AdminTabs";
import { AuditPanel } from "@/components/admin/AuditPanel";
import { CollectPanel } from "@/components/admin/CollectPanel";
import { DataSourcePanel } from "@/components/admin/DataSourcePanel";
import { HiddenSchemaPanel } from "@/components/admin/HiddenSchemaPanel";
import { PreviewAllowlistPanel } from "@/components/admin/PreviewAllowlistPanel";
import { SourceChips } from "@/components/admin/SourceChips";
import { useI18n } from "@/components/i18n";
import {
  CheckIcon,
  PlayIcon,
  PlusIcon,
  SparklesIcon,
  SyncIcon,
  TrashIcon,
  UsersIcon,
  WarningIcon,
} from "@/components/icons";
import { useMe } from "@/components/providers";
import { buildAdminTabUrl, parseAdminTab, type AdminTabId } from "@/lib/admin-tabs";
import { useElapsedSeconds } from "@/lib/use-elapsed";
import {
  addWhitelist,
  fetchAiJob,
  fetchPreviewAllowlistAdmin,
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

/** AI 색인 타일 값 — 진행 중이면 progress, 끝났으면 결과, 아직이면 대시 / embed stat values */
function describeEmbedJob(job: AiJobStatus | null): { done: string; total: string; remaining: string } {
  if (!job) return { done: "—", total: "—", remaining: "—" };
  if (job.status === "queued" || job.status === "running") {
    return {
      done: job.progress_done.toLocaleString(),
      total: job.progress_total.toLocaleString(),
      remaining: Math.max(0, job.progress_total - job.progress_done).toLocaleString(),
    };
  }
  if (job.status === "done" && job.result && "indexed" in job.result) {
    const { indexed, skipped, remaining } = job.result;
    return {
      done: indexed.toLocaleString(),
      total: (indexed + skipped + remaining).toLocaleString(),
      remaining: remaining.toLocaleString(),
    };
  }
  return { done: "—", total: "—", remaining: "—" };
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
  // null은 사내 MSSQL(기본 소스), 소스가 하나뿐이면 SourceChips가 스스로 숨는다.
  const [previewSourceId, setPreviewSourceId] = useState<number | null>(null);
  // 관리 비밀번호(X-Preview-Password) — 잠금 바 하나가 쥐고 소스·공개 범위 패널이 같이 쓴다
  const [adminPassword, setAdminPassword] = useState("");
  const [passwordConfigured, setPasswordConfigured] = useState(true);
  // 탭 카운트 pill — 각 패널이 목록을 읽을 때 알려 준다
  const [sourceCount, setSourceCount] = useState<number | undefined>(undefined);
  const [allowCount, setAllowCount] = useState<number | undefined>(undefined);
  const [auditToday, setAuditToday] = useState<number | null>(null);
  const [loginId, setLoginId] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // AD 전체 동기화는 분 단위로 걸릴 수 있다 — 경과 표시 / full AD sync can take minutes
  const [syncing, setSyncing] = useState(false);
  const syncElapsed = useElapsedSeconds(syncing);

  // 임베딩 인덱싱 잡 폴링 상태 (사이클2 Task 8) — CollectPanel과 동일한 1.5초 폴링 관용
  const [embedJobId, setEmbedJobId] = useState<number | null>(null);
  const [embedJob, setEmbedJob] = useState<AiJobStatus | null>(null);
  const [embedStarting, setEmbedStarting] = useState(false);
  const [embedError, setEmbedError] = useState<string | null>(null);
  const embedBusy = embedStarting
    || (embedJob !== null && (embedJob.status === "queued" || embedJob.status === "running"));

  // 화이트리스트와 AD 사용자는 별개 테이블 — 동기화 결과가 보이려면 둘 다 갱신해야 한다
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

  // 잠금 바의 "설정 없음" 안내 — 게이트 비밀번호 설정 여부는 허용 목록 API가 같이 알려 준다
  useEffect(() => {
    fetchPreviewAllowlistAdmin()
      .then((res) => setPasswordConfigured(res.password_configured))
      .catch((e) => setError(e.message));
  }, []);

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
  const embedStats = describeEmbedJob(embedJob);
  const embedStatus = embedBusy ? "running" : embedJob?.status === "done" ? "ok"
    : embedJob?.status === "failed" ? "failed" : null;
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

          <AdminTabs
            active={tab}
            onChange={selectTab}
            counts={{
              sources: sourceCount,
              access: allowCount,
              users: items.length,
              audit: auditToday === null ? undefined : `오늘 ${auditToday.toLocaleString()}`,
            }}
            dots={{ ai: embedStatus === "running" ? "running" : embedStatus === "ok" ? "ok" : undefined }}
          />

          {/* 소스가 없으면 나머지 관리 기능이 전부 무의미해서 첫 탭 */}
          <div {...panelProps("sources")}>
            <AdminLockBar
              value={adminPassword}
              onChange={setAdminPassword}
              configured={passwordConfigured}
              hint="관리 비밀번호를 넣으면 이 탭의 등록·수정·삭제 조작이 풀립니다. 소스 접속 비밀번호와 다른 값입니다."
            />
            <DataSourcePanel
              password={adminPassword}
              passwordConfigured={passwordConfigured}
              onLoaded={setSourceCount}
            />
            <CollectPanel />
          </div>

          <div {...panelProps("access")}>
            <AdminLockBar
              value={adminPassword}
              onChange={setAdminPassword}
              configured={passwordConfigured}
              hint="관리 비밀번호를 넣으면 허용 스키마 추가·해제와 비공개 스키마 표시 스위치가 풀립니다."
            />
            <SourceChips value={previewSourceId} onChange={setPreviewSourceId} />
            <PreviewAllowlistPanel
              sourceId={previewSourceId}
              password={adminPassword}
              passwordConfigured={passwordConfigured}
              onLoaded={setAllowCount}
            />
            <HiddenSchemaPanel password={adminPassword} passwordConfigured={passwordConfigured} />
          </div>

          <div {...panelProps("ai")}>
            <section className="mb-6" data-testid="AdminPage-embedIndexSection">
              <div className="sec-head">
                <span className="sec-head__tile"><SparklesIcon size={14} /></span>
                <h2 className="sec-head__title">{t("admin.embedIndexTitle")}</h2>
                {embedStatus === "running" && (
                  <span className="badge badge--warn badge--plain"><span className="badge__dot" />{t("admin.embedIndexRunning")}</span>
                )}
                {embedStatus === "ok" && (
                  <span className="badge badge--ok badge--plain"><span className="badge__dot" />완료</span>
                )}
                {embedStatus === "failed" && (
                  <span className="badge badge--err badge--plain"><span className="badge__dot" />{t("admin.embedIndexFailed")}</span>
                )}
              </div>
              <p className="sec-desc">{t("admin.embedIndexHint")}</p>

              <div className="stat-tiles">
                <div className="card stat-tile" data-testid="AdminPage-embedTile-done">
                  <div className="stat-tile__k">색인 완료</div>
                  <div className="stat-tile__v">{embedStats.done}</div>
                  <div className="stat-tile__sub">이번 실행에서 처리한 객체</div>
                </div>
                <div className="card stat-tile" data-testid="AdminPage-embedTile-total">
                  <div className="stat-tile__k">대상 객체</div>
                  <div className="stat-tile__v stat-tile__v--plain">{embedStats.total}</div>
                  <div className="stat-tile__sub">테이블·뷰 전체</div>
                </div>
                <div className="card stat-tile" data-testid="AdminPage-embedTile-remaining">
                  <div className="stat-tile__k">남은 객체</div>
                  <div className="stat-tile__v stat-tile__v--plain">{embedStats.remaining}</div>
                  <div className="stat-tile__sub">재실행하면 이어서 처리</div>
                </div>
              </div>

              {embedJob && (embedJob.status === "queued" || embedJob.status === "running")
                && embedJob.progress_total > 0 && (
                <div className="mb-3" data-testid="AdminPage-embedIndexProgress">
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

              <button
                className="btn-primary mb-3 inline-flex items-center gap-1.5"
                disabled={embedBusy}
                onClick={startEmbedIndexing}
                data-testid="AdminPage-embedIndexButton"
              >
                <PlayIcon size={13} />
                {embedBusy ? t("admin.embedIndexRunning") : t("admin.embedIndexButton")}
              </button>

              {embedJob && embedJob.status === "done" && embedJob.result && "indexed" in embedJob.result && (
                <div className="banner banner--ok" data-testid="AdminPage-embedIndexResult">
                  <CheckIcon size={15} />
                  <span>
                    {t("admin.embedIndexDone")
                      .replace("{indexed}", String(embedJob.result.indexed))
                      .replace("{skipped}", String(embedJob.result.skipped))
                      .replace("{remaining}", String(embedJob.result.remaining))}
                  </span>
                </div>
              )}

              {embedJob && embedJob.status === "failed" && (
                <div className="banner banner--err" data-testid="AdminPage-embedIndexErrorText">
                  <WarningIcon size={15} />
                  <span>{t("admin.embedIndexFailed")} — {embedJob.error}</span>
                </div>
              )}

              {embedError && (
                <div className="banner banner--err" data-testid="AdminPage-embedIndexStartErrorText">
                  <WarningIcon size={15} /><span>{embedError}</span>
                </div>
              )}
            </section>
          </div>

          <div {...panelProps("users")}>
            <section className="mb-6">
              <div className="sec-head">
                <span className="sec-head__tile"><UsersIcon size={14} /></span>
                <h2 className="sec-head__title">로그인 화이트리스트</h2>
                <span className="cnt-pill" data-testid="AdminPage-whitelistCount">
                  {items.length.toLocaleString()}
                </span>
                <div className="sec-head__right">
                  <button
                    className="btn-secondary inline-flex items-center gap-1.5"
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
                    <SyncIcon size={13} />
                    {syncing ? `동기화 중… ${syncElapsed}초` : "AD 전체 동기화"}
                  </button>
                </div>
              </div>
              <p className="sec-desc">
                여기 없는 계정은 로그인해도 “접근 권한이 없습니다”를 봅니다. AD 사용자 목록의
                [허용]으로도 바로 등록할 수 있습니다.
              </p>

              <div className="mb-3 flex gap-2">
                <input
                  className="ctl-field w-56"
                  placeholder="login_id (예: hong.gil)"
                  value={loginId}
                  onChange={(e) => setLoginId(e.target.value)}
                  data-testid="AdminPage-loginIdInput"
                />
                <input
                  className="ctl-field flex-1"
                  placeholder="메모 (선택)"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  data-testid="AdminPage-noteInput"
                />
                <button
                  className="btn-primary inline-flex items-center gap-1.5"
                  onClick={() =>
                    run(() => addWhitelist(loginId.trim(), note || undefined), "추가 완료")}
                  disabled={!loginId.trim()}
                  data-testid="AdminPage-addButton"
                >
                  <PlusIcon size={13} />추가
                </button>
              </div>

              <div className="card">
                <table className="data-table" data-testid="AdminPage-whitelistTable">
                  <colgroup>
                    <col style={{ width: "30%" }} /><col style={{ width: "22%" }} />
                    <col /><col style={{ width: "18%" }} /><col style={{ width: "80px" }} />
                  </colgroup>
                  <thead>
                    <tr><th>login_id</th><th>이름</th><th>메모</th><th>등록자</th><th></th></tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.login_id} className="reveal-host"
                          data-testid={`AdminPage-whitelistRow-${item.login_id}`}>
                        <td>
                          <span className="avatar">{getInitial(item.login_id)}</span>
                          <span className="font-mono text-xs" style={{ color: "var(--ink)" }}>{item.login_id}</span>
                        </td>
                        <td>{item.name ?? "—"}</td>
                        <td className="text-xs" style={{ color: "var(--slate)" }}>{item.note ?? ""}</td>
                        <td className="text-xs" style={{ color: "var(--muted)" }}>{item.added_by}</td>
                        <td className="text-right">
                          <button
                            className="icon-button reveal-action ctl-field--danger"
                            onClick={() => run(() => removeWhitelist(item.login_id), "삭제 완료")}
                            data-testid={`AdminPage-removeButton-${item.login_id}`}
                          >
                            <TrashIcon size={13} />삭제
                          </button>
                        </td>
                      </tr>
                    ))}
                    {items.length === 0 && (
                      <tr><td colSpan={5} style={{ color: "var(--muted)" }}>등록된 항목 없음</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <AdUserList
              whitelisted={whitelisted}
              refreshKey={adRefreshKey}
              onAllow={(user) => run(
                () => addWhitelist(user.login_id, user.department ?? undefined),
                `${user.login_id} 허용 추가`,
              )}
            />

            {message && (
              <div className="banner banner--ok" data-testid="AdminPage-message">
                <CheckIcon size={15} /><span>{message}</span>
              </div>
            )}
            {error && (
              <div className="banner banner--err" data-testid="AdminPage-errorText">
                <WarningIcon size={15} /><span>{error}</span>
              </div>
            )}
          </div>

          <div {...panelProps("audit")}>
            <AuditPanel onTodayCount={setAuditToday} />
          </div>
        </div>
      </div>
    </div>
  );
}
