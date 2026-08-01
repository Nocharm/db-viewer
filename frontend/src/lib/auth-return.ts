/** 로그인 왕복 북마크 — open redirect 차단 포함 (bpm 패턴) / login round-trip bookkeeping. */

const RETURN_KEY = "dbv.returnTo";
const AUTO_TRIED_KEY = "dbv.autoLoginTried";

export function isSafeReturnPath(path: string): boolean {
  // 내부 경로만 허용 — '//host'는 스킴 상대 URL이라 차단 / block scheme-relative URLs
  return path.startsWith("/") && !path.startsWith("//");
}

export function saveReturnTo(path: string): void {
  if (isSafeReturnPath(path)) sessionStorage.setItem(RETURN_KEY, path);
}

export function consumeReturnTo(): string {
  const value = sessionStorage.getItem(RETURN_KEY);
  sessionStorage.removeItem(RETURN_KEY);
  return value && isSafeReturnPath(value) ? value : "/";
}

/** 자동(silent) 로그인은 1회만 시도 — 루프 방지 / one-shot silent-login guard. */
export function markAutoLoginTried(): void {
  sessionStorage.setItem(AUTO_TRIED_KEY, "1");
}

export function wasAutoLoginTried(): boolean {
  return sessionStorage.getItem(AUTO_TRIED_KEY) === "1";
}

export function clearAutoLoginTried(): void {
  sessionStorage.removeItem(AUTO_TRIED_KEY);
}
