import { beforeEach, describe, expect, it } from "vitest";

import { clearStoredSession, readStoredSession, storeSession } from "./session-token";

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
});
