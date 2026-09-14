/** 감사 로그 화면의 순수 로직 — 동작 라벨 키·분류·기간·요약. 화면 없이 테스트한다.
 * 라벨은 문자열이 아니라 사전 키로 들고 있다 — UI 언어 토글이 이 표에도 닿아야 한다.
 * Pure helpers for the audit panel: label keys, categories, period ranges, summaries.
 * Labels are dictionary keys, not literals, so the language toggle reaches this table too. */

import type { MessageKey } from "@/lib/i18n";

export type AuditCategory = "exposure" | "policy" | "ops" | "login";

// 코드 그대로는 무슨 조작인지 안 읽힌다 — 목록에 없는 action은 코드를 그대로 보여준다
// (새 action이 생겨도 화면이 비지 않게) / unknown actions fall back to the raw code
export const ACTION_LABEL_KEYS: Record<string, MessageKey> = {
  table_preview: "audit.action.table_preview",
  join_preview: "audit.action.join_preview",
  preview: "audit.action.preview",
  value_probe: "audit.action.value_probe",
  value_probe_heavy: "audit.action.value_probe_heavy",
  whitelist_add: "audit.action.whitelist_add",
  whitelist_remove: "audit.action.whitelist_remove",
  preview_allow_add: "audit.action.preview_allow_add",
  preview_allow_remove: "audit.action.preview_allow_remove",
  hidden_schema_render_set: "audit.action.hidden_schema_render_set",
  confirm: "audit.action.confirm",
  category_set: "audit.action.category_set",
  source_create: "audit.action.source_create",
  source_update: "audit.action.source_update",
  source_delete: "audit.action.source_delete",
  source_test: "audit.action.source_test",
  collect_trigger: "audit.action.collect_trigger",
  collect_cancel: "audit.action.collect_cancel",
  ad_sync_all: "audit.action.ad_sync_all",
  embed_index_trigger: "audit.action.embed_index_trigger",
  login: "audit.action.login",
  ldap_login: "audit.action.ldap_login",
  access_denied: "audit.action.access_denied",
};

/** 동작 분류 — 필터 드롭다운의 optgroup과 행의 pill 색이 이 순서를 따른다 */
export const ACTION_GROUPS: { category: AuditCategory; labelKey: MessageKey; actions: string[] }[] = [
  { category: "exposure", labelKey: "audit.group.exposure",
    actions: ["table_preview", "join_preview", "preview", "value_probe", "value_probe_heavy"] },
  { category: "policy", labelKey: "audit.group.policy",
    actions: ["preview_allow_add", "preview_allow_remove", "whitelist_add", "whitelist_remove",
      "hidden_schema_render_set", "confirm", "category_set"] },
  { category: "ops", labelKey: "audit.group.ops",
    actions: ["source_create", "source_update", "source_delete", "source_test",
      "collect_trigger", "collect_cancel", "ad_sync_all", "embed_index_trigger"] },
  { category: "login", labelKey: "audit.group.login", actions: ["login", "ldap_login", "access_denied"] },
];

const CATEGORY_BY_ACTION = new Map<string, AuditCategory>(
  ACTION_GROUPS.flatMap((group) =>
    group.actions.map((action) => [action, group.category] as [string, AuditCategory])),
);

export function getActionCategory(action: string): AuditCategory {
  return CATEGORY_BY_ACTION.get(action) ?? "ops";
}

/** 실패 행 — 접근 거부이거나 detail이 "<대상> fail…" 꼴(LDAP 실패·연결 테스트 실패). */
export function isFailedEntry(action: string, detail: string): boolean {
  return action === "access_denied" || /(^|\s)fail(\s|\(|$)/.test(detail);
}

export type AuditPeriod = "today" | "7d" | "30d" | "all";

export const PERIOD_LABEL_KEYS: Record<AuditPeriod, MessageKey> = {
  today: "audit.period.today", "7d": "audit.period.7d",
  "30d": "audit.period.30d", all: "audit.period.all",
};

// 오늘을 포함해 며칠을 거슬러 볼지 — 7일은 오늘 포함 7일 / days back, today inclusive
const PERIOD_DAYS_BACK: Record<Exclude<AuditPeriod, "all">, number> = { today: 0, "7d": 6, "30d": 29 };

/** 기간 칩 → [from, ∞). 로컬 자정 기준 — 백엔드는 [from, to)로 받는다. */
export function buildPeriodRange(
  period: AuditPeriod, now: Date,
): { dateFrom?: string; dateTo?: string } {
  if (period === "all") return {};
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - PERIOD_DAYS_BACK[period]);
  return { dateFrom: start.toISOString() };
}

/** 날짜 입력(YYYY-MM-DD)을 [from, to) ISO로 — to는 다음 날 자정(미포함 상한). */
export function toIsoRange(from: string, to: string): { dateFrom?: string; dateTo?: string } {
  const range: { dateFrom?: string; dateTo?: string } = {};
  if (from) range.dateFrom = new Date(`${from}T00:00:00`).toISOString();
  if (to) {
    const next = new Date(`${to}T00:00:00`);
    next.setDate(next.getDate() + 1);
    range.dateTo = next.toISOString();
  }
  return range;
}

export interface AuditSummary {
  total: number;
  exposure: number;
  policy: number;
}

/** 요약 타일 — action별 건수를 분류별로 합친다 (로그인 실패는 detail이 필요해 백엔드가 센다) */
export function summarizeCounts(counts: Record<string, number>): AuditSummary {
  let total = 0;
  let exposure = 0;
  let policy = 0;
  for (const [action, count] of Object.entries(counts)) {
    total += count;
    const category = getActionCategory(action);
    if (category === "exposure") exposure += count;
    if (category === "policy") policy += count;
  }
  return { total, exposure, policy };
}
