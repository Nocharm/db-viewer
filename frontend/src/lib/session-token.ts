/** LDAP 로그인 세션의 브라우저 저장 + 인증 판정 — 순수 로직. / LDAP session storage and auth decisions.
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

/** API에 실을 토큰을 고른다 / which token the API client should carry.
 *  Keycloak 토큰이 있으면 그것이 이긴다. 없을 때 로컬(LDAP) 토큰으로 떨어지는 이 폴백이
 *  빠지면, Keycloak이 설정된 배포에서 LDAP으로 로그인한 사용자의 토큰이 렌더마다 지워진다 —
 *  바로 Keycloak 장애용 폴백이 필요한 그 상황에서만 기능이 죽는다. */
export function resolveActiveToken(
  keycloakToken: string | null, localToken: string | null,
): string | null {
  return keycloakToken ?? localToken;
}

/** 어느 경로로든 인증된 상태인가 / whether either auth path has a live session.
 *  게이트는 이 값으로 판단해야 한다 — Keycloak 여부만 보면 LDAP 사용자가 /login으로 되튄다. */
export function isSessionActive(keycloakAuthed: boolean, hasLocalSession: boolean): boolean {
  return keycloakAuthed || hasLocalSession;
}

export function hasStoredSession(): boolean {
  // 만료 여부와 무관하게 "저장분이 있었는가"만 본다 — readStoredSession()은 만료를 만나면
  // 스스로 지우고 null을 주므로, 그것으로 판단하면 정작 만료 상황에서 false가 된다.
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}
