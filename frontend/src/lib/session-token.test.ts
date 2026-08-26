import { beforeEach, describe, expect, it } from "vitest";

import {
  clearStoredSession,
  hasStoredSession,
  isSessionActive,
  readStoredSession,
  resolveActiveToken,
  storeSession,
} from "./session-token";

// vitest 환경이 "node"라 localStorage가 없다 — 이 모듈이 쓰는 3개 메서드만 흉내낸다
function installStorageStub(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => void store.set(k, v),
      removeItem: (k: string): void => void store.delete(k),
      clear: (): void => store.clear(),
    },
  });
}

const VALID = {
  token: "a.b.c",
  expiresAt: "2026-08-27T00:00:00.000Z",
  loginId: "hong.gildong",
  name: "홍길동",
};

describe("session-token", () => {
  beforeEach(() => installStorageStub());

  it("round-trips a stored session", () => {
    storeSession(VALID);
    expect(readStoredSession(new Date("2026-08-26T12:00:00Z"))).toEqual(VALID);
  });

  it("returns null once the session has expired", () => {
    storeSession(VALID);
    expect(readStoredSession(new Date("2026-08-27T00:00:01Z"))).toBeNull();
  });

  it("clears the stored value when it has expired", () => {
    storeSession(VALID);
    readStoredSession(new Date("2026-08-27T00:00:01Z"));
    expect(localStorage.getItem("dbv.session")).toBeNull();
  });

  it("returns null for malformed stored JSON instead of throwing", () => {
    localStorage.setItem("dbv.session", "{not json");
    expect(readStoredSession(new Date("2026-08-26T12:00:00Z"))).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    localStorage.setItem("dbv.session", JSON.stringify({ token: "a.b.c" }));
    expect(readStoredSession(new Date("2026-08-26T12:00:00Z"))).toBeNull();
  });

  it("clearStoredSession removes the key", () => {
    storeSession(VALID);
    clearStoredSession();
    expect(localStorage.getItem("dbv.session")).toBeNull();
  });

  it("hasStoredSession returns false when nothing is stored", () => {
    expect(hasStoredSession()).toBe(false);
  });

  it("hasStoredSession returns true for a valid stored session", () => {
    storeSession(VALID);
    expect(hasStoredSession()).toBe(true);
  });

  // 리다이렉트 가드가 이 값에 의존하다 버그가 났다: readStoredSession()은 만료된 값을
  // 스스로 지우고 null을 주므로, 그것으로 "세션이 있었는가"를 물으면 만료 시 항상 false다.
  it("returns true for an expired session — the exact case readStoredSession() nulls out", () => {
    const expired = { ...VALID, expiresAt: "2000-01-01T00:00:00.000Z" };
    storeSession(expired);
    expect(hasStoredSession()).toBe(true);
    expect(readStoredSession(new Date("2026-08-26T12:00:00Z"))).toBeNull();
  });
});

describe("resolveActiveToken", () => {
  // AuthGate가 auth.user 기준으로 무조건 덮어써서 LDAP 로그인이 통째로 깨졌던 자리.
  // Keycloak이 설정된 배포에서 LDAP으로 들어오면 이 조합이 매번 발생한다.
  it("keeps the local token when Keycloak has none — the case that broke LDAP login", () => {
    expect(resolveActiveToken(null, "ldap-token")).toBe("ldap-token");
  });

  it("prefers the Keycloak token when both are present", () => {
    expect(resolveActiveToken("kc-token", "ldap-token")).toBe("kc-token");
  });

  it("uses the Keycloak token when there is no local session", () => {
    expect(resolveActiveToken("kc-token", null)).toBe("kc-token");
  });

  it("returns null when neither side has a token", () => {
    expect(resolveActiveToken(null, null)).toBeNull();
  });
});

describe("isSessionActive", () => {
  it("is true when Keycloak is authenticated", () => {
    expect(isSessionActive(true, false)).toBe(true);
  });

  // 이 줄이 false를 주면 AuthGate가 방금 로그인한 사용자를 /login으로 되돌려보낸다
  it("is true when only a local LDAP session exists", () => {
    expect(isSessionActive(false, true)).toBe(true);
  });

  it("is true when both are present", () => {
    expect(isSessionActive(true, true)).toBe(true);
  });

  it("is false when neither is present", () => {
    expect(isSessionActive(false, false)).toBe(false);
  });
});
