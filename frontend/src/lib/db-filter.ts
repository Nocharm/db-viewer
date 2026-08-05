/** DB(스키마) 필터의 브라우저 영속 — 선택 목록만 저장 / per-browser persistence of the DB filter.
 *
 * 서버가 아니라 localStorage인 이유: 카테고리 매핑은 조직 공용이지만 "지금 내가 보고
 * 싶은 DB"는 사람마다 다르다. 테마·언어와 같은 층위다.
 */

const STORAGE_KEY = "dbv.dbFilter";

/** 빈 배열 = 전체 표시 (필터 없음) / empty means no filter, show everything. */
export function loadDbFilter(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return []; // 차단·손상 — 필터 없음으로 시작 / blocked or corrupt: no filter
  }
}

export function saveDbFilter(schemas: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(schemas));
  } catch {
    // localStorage 차단 환경 — 세션 한정 필터 / session-only filter
  }
}
