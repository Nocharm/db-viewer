/** 감사 로그 화면의 순수 로직 — 동작 라벨·분류·기간·요약. 화면 없이 테스트한다.
 * Pure helpers for the audit panel: labels, categories, period ranges, summaries. */

export type AuditCategory = "exposure" | "policy" | "ops" | "login";

// 코드 그대로는 무슨 조작인지 안 읽힌다 — 목록에 없는 action은 코드를 그대로 보여준다
// (새 action이 생겨도 화면이 비지 않게) / unknown actions fall back to the raw code
export const ACTION_LABELS: Record<string, string> = {
  table_preview: "테이블 미리보기",
  join_preview: "조인 미리보기",
  preview: "조인 검증 미리보기",
  value_probe: "값 추적",
  value_probe_heavy: "값 추적 — 무거운 객체",
  whitelist_add: "화이트리스트 등록",
  whitelist_remove: "화이트리스트 해제",
  preview_allow_add: "미리보기 허용 등록",
  preview_allow_remove: "미리보기 허용 해제",
  hidden_schema_render_set: "감춘 스키마 표시 토글",
  confirm: "관계 확정",
  category_set: "스키마 카테고리 변경",
  source_create: "데이터 소스 등록",
  source_update: "데이터 소스 수정",
  source_delete: "데이터 소스 삭제",
  source_test: "소스 연결 테스트",
  collect_trigger: "카탈로그 수집",
  collect_cancel: "카탈로그 수집 중단",
  ad_sync_all: "AD 전체 동기화",
  embed_index_trigger: "AI 색인 시작",
  login: "로그인 (Keycloak)",
  ldap_login: "로그인 (LDAP)",
  access_denied: "접근 거부 (화이트리스트 밖)",
};

/** 동작 분류 — 필터 드롭다운의 optgroup과 행의 pill 색이 이 순서를 따른다 */
export const ACTION_GROUPS: { category: AuditCategory; label: string; actions: string[] }[] = [
  { category: "exposure", label: "실값 반출",
    actions: ["table_preview", "join_preview", "preview", "value_probe", "value_probe_heavy"] },
  { category: "policy", label: "권한·설정",
    actions: ["preview_allow_add", "preview_allow_remove", "whitelist_add", "whitelist_remove",
      "hidden_schema_render_set", "confirm", "category_set"] },
  { category: "ops", label: "소스·수집",
    actions: ["source_create", "source_update", "source_delete", "source_test",
      "collect_trigger", "collect_cancel", "ad_sync_all", "embed_index_trigger"] },
  { category: "login", label: "로그인", actions: ["login", "ldap_login", "access_denied"] },
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

export const PERIOD_LABELS: Record<AuditPeriod, string> = {
  today: "오늘", "7d": "7일", "30d": "30일", all: "전체",
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
