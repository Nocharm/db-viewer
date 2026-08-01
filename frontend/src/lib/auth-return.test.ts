import { describe, expect, it } from "vitest";

import { isSafeReturnPath } from "./auth-return";

describe("isSafeReturnPath", () => {
  it("allows internal paths only", () => {
    expect(isSafeReturnPath("/")).toBe(true);
    expect(isSafeReturnPath("/parsing?x=1")).toBe(true);
  });

  it("blocks open-redirect shapes", () => {
    expect(isSafeReturnPath("//evil.example")).toBe(false);
    expect(isSafeReturnPath("http://evil.example")).toBe(false);
    expect(isSafeReturnPath("javascript:alert(1)")).toBe(false);
  });
});
