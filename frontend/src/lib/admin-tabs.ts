/** 관리 콘솔 탭 정의와 URL(?tab=) 해석 — 순수 함수라 화면 없이 테스트한다.
 * Admin console tab ids plus the ?tab= parsing, kept pure so it is testable without React. */

export const ADMIN_TAB_IDS = ["sources", "access", "ai", "users"] as const;

export type AdminTabId = (typeof ADMIN_TAB_IDS)[number];

export const DEFAULT_ADMIN_TAB: AdminTabId = "sources";

function isAdminTabId(value: string): value is AdminTabId {
  return (ADMIN_TAB_IDS as readonly string[]).includes(value);
}

/** ?tab= 값을 탭 id로 — 모르는 값·빈 값은 첫 탭(소스). 딥링크가 오타여도 빈 화면은 안 된다. */
export function parseAdminTab(value: string | null | undefined): AdminTabId {
  if (!value) return DEFAULT_ADMIN_TAB;
  return isAdminTabId(value) ? value : DEFAULT_ADMIN_TAB;
}

/** 현재 주소의 ?tab=만 바꾼 URL 문자열 — 기본 탭이면 파라미터를 빼서 주소를 짧게 유지한다. */
export function buildAdminTabUrl(pathname: string, search: string, tab: AdminTabId): string {
  const params = new URLSearchParams(search);
  if (tab === DEFAULT_ADMIN_TAB) params.delete("tab");
  else params.set("tab", tab);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** 좌우 화살표 키로 이웃 탭으로 — 끝에서는 반대편으로 감는다(WAI-ARIA tabs 관용). */
export function getNeighbourTab(current: AdminTabId, direction: -1 | 1): AdminTabId {
  const index = ADMIN_TAB_IDS.indexOf(current);
  const next = (index + direction + ADMIN_TAB_IDS.length) % ADMIN_TAB_IDS.length;
  return ADMIN_TAB_IDS[next];
}
