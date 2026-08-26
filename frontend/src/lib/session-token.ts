/** LDAP 로그인 세션의 브라우저 저장 — 순수 로직. / browser-side storage for the LDAP session.
 *  갱신 토큰이 없으므로 만료된 값은 읽는 즉시 버린다. */

const KEY = "dbv.session";

export interface StoredSession {
  token: string;
  expiresAt: string;
  loginId: string;
  name: string | null;
}

function isSession(value: unknown): value is StoredSession {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.token === "string" && typeof v.expiresAt === "string"
    && typeof v.loginId === "string";
}

export function readStoredSession(now: Date = new Date()): StoredSession | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null; // 사파리 프라이빗 등 storage 접근 자체가 막힌 경우
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearStoredSession();
    return null;
  }
  if (!isSession(parsed)) {
    clearStoredSession();
    return null;
  }
  // 만료분을 남겨두면 매 요청이 401을 받고 리다이렉트가 반복된다
  if (new Date(parsed.expiresAt).getTime() <= now.getTime()) {
    clearStoredSession();
    return null;
  }
  return { ...parsed, name: typeof parsed.name === "string" ? parsed.name : null };
}

export function storeSession(session: StoredSession): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // 저장 실패는 치명적이지 않다 — 이번 탭에서는 메모리의 토큰으로 동작한다
  }
}

export function clearStoredSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // 위와 같은 이유
  }
}
