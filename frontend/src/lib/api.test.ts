import { describe, expect, it } from "vitest";

import { formatDeleteBlockedMessage, shouldRedirectToLogin } from "./api";

describe("formatDeleteBlockedMessage", () => {
  it("falls back when there is no context at all", () => {
    expect(formatDeleteBlockedMessage(null, "request failed (409)"))
      .toBe("request failed (409)");
    expect(formatDeleteBlockedMessage(undefined, "request failed (409)"))
      .toBe("request failed (409)");
  });

  it("falls back when the context carries no nonzero counts", () => {
    expect(formatDeleteBlockedMessage({}, "fallback")).toBe("fallback");
    expect(formatDeleteBlockedMessage(
      { snapshots: 0, preview_allowlist: 0, schema_categories: 0 }, "fallback",
    )).toBe("fallback");
  });

  it("names a single blocking count", () => {
    expect(formatDeleteBlockedMessage({ snapshots: 3 }, "fallback")).toBe(
      "스냅샷 3건이 이 소스를 참조하고 있어 삭제할 수 없습니다 — "
      + "비활성화하거나 먼저 정리하세요.",
    );
  });

  it("joins multiple blocking counts in a fixed order", () => {
    expect(formatDeleteBlockedMessage(
      { snapshots: 3, preview_allowlist: 2, schema_categories: 1 }, "fallback",
    )).toBe(
      "스냅샷 3건·허용 목록 2건·카테고리 1건이 이 소스를 참조하고 있어 "
      + "삭제할 수 없습니다 — 비활성화하거나 먼저 정리하세요.",
    );
  });

  it("skips zero-valued fields even when others are nonzero", () => {
    expect(formatDeleteBlockedMessage(
      { snapshots: 0, preview_allowlist: 2, schema_categories: 0 }, "fallback",
    )).toBe(
      "허용 목록 2건이 이 소스를 참조하고 있어 삭제할 수 없습니다 — "
      + "비활성화하거나 먼저 정리하세요.",
    );
  });
});

describe("shouldRedirectToLogin", () => {
  it("redirects on a 401 while a session is stored and off the login page", () => {
    expect(shouldRedirectToLogin(401, "/objects", true)).toBe(true);
  });

  it("never redirects from the login page itself — avoids the retry loop", () => {
    expect(shouldRedirectToLogin(401, "/login", true)).toBe(false);
  });

  it("does not redirect when no session was ever stored (dev-mode X-Dev-User calls)", () => {
    expect(shouldRedirectToLogin(401, "/objects", false)).toBe(false);
  });

  it("does not redirect on a non-401 status", () => {
    expect(shouldRedirectToLogin(200, "/objects", true)).toBe(false);
  });
});
