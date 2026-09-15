/** 좌측 목록 배치 모드의 브라우저 영속 — 3열이냐 통합 트리냐.
 *
 * `db-filter.ts`와 같은 층위다: 조직 공용 설정이 아니라 "내 화면을 어떻게 볼지"라
 * 서버가 아니라 localStorage에 둔다.
 */

export type BrowserLayout = "classic" | "tree";

const STORAGE_KEY = "dbv.browserLayout";

/** 기본은 3열 — 기존 사용자의 화면이 업데이트만으로 바뀌면 안 된다. */
export const DEFAULT_BROWSER_LAYOUT: BrowserLayout = "classic";

export function loadBrowserLayout(): BrowserLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "tree" || raw === "classic" ? raw : DEFAULT_BROWSER_LAYOUT;
  } catch {
    return DEFAULT_BROWSER_LAYOUT; // 차단·손상 — 기본 배치 / blocked or corrupt
  }
}

export function saveBrowserLayout(layout: BrowserLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, layout);
  } catch {
    // localStorage 차단 환경 — 세션 한정 / session-only
  }
}
