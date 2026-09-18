/** 관리 잠금 비밀번호의 세션 보관 — 검증을 통과한 값만 넣는다. sessionStorage라 탭 전환·
 * 새로고침엔 살아남고 브라우저 세션이 끝나면 사라진다(localStorage처럼 남기지 않는다).
 * / verified admin password kept for the browser session only. */

const STORAGE_KEY = "dbv.adminPassword";

export function readStoredAdminPassword(): string {
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return ""; // 저장소 차단 환경 — 화면 상태로만 유지 / storage blocked: in-memory only
  }
}

export function storeAdminPassword(value: string): void {
  try {
    if (value) sessionStorage.setItem(STORAGE_KEY, value);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // 저장소 차단 환경 — 다음 새로고침에 다시 묻는다 / storage blocked: ask again after reload
  }
}
