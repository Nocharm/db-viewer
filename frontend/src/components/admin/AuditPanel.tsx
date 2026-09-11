"use client";

/** 감사 로그 탭 — 기간 칩·요약 타일·필터(동작/요청자/대상 드롭다운·내용·기간)·한 줄 행·상세 모달.
 * 실값 반출과 권한·설정 변경이 같은 표에 쌓이고 수정·삭제 경로는 없다.
 * Audit log tab: period chips, summary tiles, dropdown filters, single-line rows, detail modal. */

import { useCallback, useEffect, useState } from "react";

import { AuditDetailModal, getAuditBadgeClass } from "@/components/admin/AuditDetailModal";
import { getInitial } from "@/components/admin/AdUserList";
import { BanIcon, ClipboardIcon, SyncIcon, WarningIcon } from "@/components/icons";
import { fetchAuditLog, type AuditEntry } from "@/lib/api";
import {
  ACTION_GROUPS,
  ACTION_LABELS,
  PERIOD_LABELS,
  buildPeriodRange,
  summarizeCounts,
  toIsoRange,
  type AuditPeriod,
} from "@/lib/audit";

const PERIODS: AuditPeriod[] = ["today", "7d", "30d", "all"];
const PAGE_SIZES = [100, 200, 500] as const;
// 텍스트 입력은 타자마다 요청하지 않게 짧게 디바운스 — 셀렉트·날짜·페이지는 같은 경로라 같이 탄다
const LOAD_DEBOUNCE_MS = 300;

const pad = (n: number) => String(n).padStart(2, "0");

function formatClock(iso: string): string {
  const at = new Date(iso);
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 날짜 꼬리표 — 오늘/어제는 말로, 그 외는 MM-DD / day label under the clock */
function formatDayLabel(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (at.toDateString() === now.toDateString()) return "오늘";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (at.toDateString() === yesterday.toDateString()) return "어제";
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

interface AuditPanelProps {
  /** 오늘 쌓인 건수를 알린다 — 탭 카운트 pill용 (마운트 시 한 번) */
  onTodayCount?: (count: number) => void;
}

export function AuditPanel({ onTodayCount }: AuditPanelProps) {
  const [period, setPeriod] = useState<AuditPeriod>("7d");
  const [action, setAction] = useState("");
  const [requestedBy, setRequestedBy] = useState("");
  const [target, setTarget] = useState("");
  const [q, setQ] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0]);
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [requesters, setRequesters] = useState<string[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [failedLogins, setFailedLogins] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  // 날짜를 직접 넣으면 기간 칩 대신 그 범위를 쓴다 / explicit dates override the period chip
  const customRange = Boolean(dateFrom || dateTo);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchAuditLog({
      action: action || undefined,
      requestedBy: requestedBy || undefined,
      target: target.trim() || undefined,
      q: q.trim() || undefined,
      ...(customRange ? toIsoRange(dateFrom, dateTo) : buildPeriodRange(period, new Date())),
      limit: pageSize, offset,
    })
      .then((res) => {
        setItems(res.items);
        setActions(res.actions);
        setRequesters(res.requesters);
        setTargets(res.targets);
        setCounts(res.counts_by_action);
        setFailedLogins(res.failed_logins);
        setTotal(res.total);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [action, requestedBy, target, q, dateFrom, dateTo, customRange, period, pageSize, offset]);

  useEffect(() => {
    const timer = setTimeout(load, LOAD_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [load]);

  // 탭 카운트용 오늘 건수 — 목록 필터와 무관하게 한 번만 센다
  useEffect(() => {
    if (!onTodayCount) return;
    fetchAuditLog({ ...buildPeriodRange("today", new Date()), limit: 1 })
      .then((res) => onTodayCount(res.total))
      .catch((e: Error) => setError(e.message));
  }, [onTodayCount]);

  const resetPage = () => setOffset(0);
  const hasFilters = Boolean(action || requestedBy || target || q || dateFrom || dateTo);
  const clearFilters = () => {
    setAction(""); setRequestedBy(""); setTarget(""); setQ("");
    setDateFrom(""); setDateTo(""); resetPage();
  };

  const summary = summarizeCounts(counts);
  const knownActions = new Set(ACTION_GROUPS.flatMap((group) => group.actions));
  const periodLabel = customRange ? "선택 기간" : PERIOD_LABELS[period];

  return (
    <section data-testid="AuditPanel-root">
      <div className="sec-head">
        <span className="sec-head__tile"><ClipboardIcon size={14} /></span>
        <h2 className="sec-head__title">감사 로그</h2>
        <span className="cnt-pill" data-testid="AuditPanel-total">{total.toLocaleString()}</span>
        <div className="sec-head__right">
          <span className="period-chips" role="group" aria-label="기간">
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                className={`period-chips__btn${period === p && !customRange ? " period-chips__btn--on" : ""}`}
                aria-pressed={period === p && !customRange}
                onClick={() => { setPeriod(p); setDateFrom(""); setDateTo(""); resetPage(); }}
                data-testid={`AuditPanel-period-${p}`}
              >
                {PERIOD_LABELS[p]}
              </button>
            ))}
          </span>
          <button className="icon-button ctl-field" onClick={load} disabled={loading}
                  data-testid="AuditPanel-refreshButton">
            <SyncIcon size={13} />{loading ? "불러오는 중…" : "새로고침"}
          </button>
        </div>
      </div>
      <p className="sec-desc">
        실제 값을 본 기록(미리보기·조인 샘플·값 추적)과 권한·설정 변경, 로그인이 최신순으로 남습니다.
        수정·삭제는 없습니다. 행을 누르면 전문이 열립니다.
      </p>

      <div className="stat-tiles stat-tiles--4">
        <div className="card stat-tile" data-testid="AuditPanel-tile-total">
          <div className="stat-tile__k">{periodLabel} 전체</div>
          <div className="stat-tile__v stat-tile__v--plain">{summary.total.toLocaleString()}</div>
        </div>
        <div className="card stat-tile" data-testid="AuditPanel-tile-exposure">
          <div className="stat-tile__k">실값 반출</div>
          <div className="stat-tile__v">{summary.exposure.toLocaleString()}</div>
          <div className="stat-tile__sub">미리보기 · 조인 샘플 · 값 추적</div>
        </div>
        <div className="card stat-tile" data-testid="AuditPanel-tile-policy">
          <div className="stat-tile__k">권한·설정 변경</div>
          <div className="stat-tile__v stat-tile__v--plain">{summary.policy.toLocaleString()}</div>
          <div className="stat-tile__sub">허용 스키마 · 화이트리스트 · 관계 확정</div>
        </div>
        <div className="card stat-tile" data-testid="AuditPanel-tile-loginFail">
          <div className="stat-tile__k">로그인 실패·거부</div>
          <div className={`stat-tile__v ${failedLogins > 0 ? "stat-tile__v--danger" : "stat-tile__v--plain"}`}>
            {failedLogins.toLocaleString()}
          </div>
          <div className="stat-tile__sub">LDAP 실패 · 화이트리스트 밖 접근</div>
        </div>
      </div>

      <div className="audit-filters">
        <select
          className="ctl-field"
          value={action}
          onChange={(e) => { setAction(e.target.value); resetPage(); }}
          data-testid="AuditPanel-actionFilter"
        >
          <option value="">동작: 전체</option>
          {ACTION_GROUPS.map((group) => {
            const present = group.actions.filter((a) => actions.includes(a));
            return present.length === 0 ? null : (
              <optgroup key={group.category} label={group.label}>
                {present.map((a) => <option key={a} value={a}>{ACTION_LABELS[a] ?? a}</option>)}
              </optgroup>
            );
          })}
          {/* 분류에 없는 새 action도 잃지 않는다 / unknown actions still filterable */}
          {actions.filter((a) => !knownActions.has(a)).map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <select
          className="ctl-field"
          value={requestedBy}
          onChange={(e) => { setRequestedBy(e.target.value); resetPage(); }}
          data-testid="AuditPanel-requesterFilter"
        >
          <option value="">요청자: 전체</option>
          {requesters.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <input
          className="ctl-field"
          list="AuditPanel-targets"
          placeholder="대상 (선택 또는 입력)"
          value={target}
          onChange={(e) => { setTarget(e.target.value); resetPage(); }}
          data-testid="AuditPanel-targetFilter"
        />
        <datalist id="AuditPanel-targets">
          {targets.map((t) => <option key={t} value={t} />)}
        </datalist>
        <input
          className="ctl-field"
          style={{ minWidth: 160 }}
          placeholder="내용 검색"
          value={q}
          onChange={(e) => { setQ(e.target.value); resetPage(); }}
          data-testid="AuditPanel-detailFilter"
        />
        <span className="audit-filters__dates">
          <input type="date" className="ctl-field" value={dateFrom}
                 onChange={(e) => { setDateFrom(e.target.value); resetPage(); }}
                 data-testid="AuditPanel-dateFromFilter" />
          <span style={{ color: "var(--muted)" }}>~</span>
          <input type="date" className="ctl-field" value={dateTo}
                 onChange={(e) => { setDateTo(e.target.value); resetPage(); }}
                 data-testid="AuditPanel-dateToFilter" />
        </span>
        <button className="icon-button ctl-field audit-filters__clear" disabled={!hasFilters}
                onClick={clearFilters} data-testid="AuditPanel-clearFilters">
          <BanIcon size={13} />필터 해제
        </button>
      </div>
      <div className="audit-legend" aria-hidden>
        <span className="badge badge--warn badge--plain"><span className="badge__dot" />실값 반출</span>
        <span className="badge badge--view badge--plain"><span className="badge__dot" />권한·설정</span>
        <span className="badge badge--muted badge--plain"><span className="badge__dot" />소스·수집</span>
        <span className="badge badge--login badge--plain"><span className="badge__dot" />로그인</span>
        <span className="badge badge--err badge--plain"><span className="badge__dot" />실패·거부</span>
      </div>

      <div className="card">
        <table className="data-table" data-testid="AuditPanel-table">
          <colgroup>
            <col style={{ width: 100 }} /><col style={{ width: 200 }} /><col /><col style={{ width: 150 }} />
          </colgroup>
          <thead>
            <tr><th>시각</th><th>동작</th><th>대상</th><th>요청자</th></tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.id}
                className="audit-row reveal-host"
                tabIndex={0}
                role="button"
                aria-label={`감사 기록 #${item.id} 상세 열기`}
                onClick={() => setSelected(item)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(item); }
                }}
                data-testid={`AuditPanel-row-${item.id}`}
              >
                <td className="audit-when">
                  {formatClock(item.requested_at)}
                  <small>{formatDayLabel(item.requested_at)}</small>
                </td>
                <td>
                  <span className={`badge badge--plain ${getAuditBadgeClass(item)}`}>
                    {ACTION_LABELS[item.action] ?? item.action}
                  </span>
                </td>
                <td className="audit-target" title={item.detail}>{item.detail}</td>
                <td className="audit-who">
                  <span className="avatar">{getInitial(item.requested_by)}</span>
                  {item.requested_by}
                </td>
              </tr>
            ))}
            {items.length === 0 && !loading && (
              <tr><td colSpan={4} style={{ color: "var(--muted)" }} data-testid="AuditPanel-emptyState">
                기록 없음
              </td></tr>
            )}
          </tbody>
        </table>
        <div className="pager">
          <span className="pager__range" data-testid="AuditPanel-range">
            {total === 0 ? "0" : `${offset + 1}–${Math.min(offset + pageSize, total)}`}
          </span>
          <span>/ {total.toLocaleString()}건</span>
          <span className="pager__spacer" />
          <select
            className="ctl-field"
            value={pageSize}
            onChange={(e) => { setPageSize(Number(e.target.value)); resetPage(); }}
            data-testid="AuditPanel-pageSize"
          >
            {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}건씩</option>)}
          </select>
          <button className="icon-button ctl-field" disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - pageSize))}
                  data-testid="AuditPanel-prevButton">
            ‹ 이전
          </button>
          <button className="icon-button ctl-field" disabled={offset + pageSize >= total}
                  onClick={() => setOffset(offset + pageSize)}
                  data-testid="AuditPanel-nextButton">
            다음 ›
          </button>
        </div>
      </div>

      {error && (
        <div className="banner banner--err mt-3" data-testid="AuditPanel-error">
          <WarningIcon size={15} /><span>{error}</span>
        </div>
      )}

      <AuditDetailModal entry={selected} onClose={() => setSelected(null)} />
    </section>
  );
}
