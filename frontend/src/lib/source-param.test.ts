import { describe, expect, it } from "vitest";

import { readSourceId, withSourceParam, withSourceQuery } from "./source-param";

describe("readSourceId", () => {
  it("reads a numeric source from the query string", () => {
    expect(readSourceId("?source=3")).toBe(3);
  });

  it("returns null when absent so the default source is used", () => {
    expect(readSourceId("")).toBeNull();
    expect(readSourceId("?q=abc")).toBeNull();
  });

  it("rejects non-numeric values instead of forwarding them to the API", () => {
    expect(readSourceId("?source=../admin")).toBeNull();
  });
});

describe("withSourceParam", () => {
  it("appends source_id when a source is selected", () => {
    expect(withSourceParam("/api/objects?q=a", 3)).toBe("/api/objects?q=a&source_id=3");
  });

  it("leaves the path untouched for the default source", () => {
    expect(withSourceParam("/api/objects", null)).toBe("/api/objects");
  });
});

describe("withSourceQuery", () => {
  // page.tsx의 selectTable/changeCategory 같은 router.push 경로용 — 테이블을 클릭할
  // 때마다 ?source=가 사라지면 새로고침이 조용히 기본 소스로 돌아간다
  it("preserves the selected source across a table-selection navigation", () => {
    expect(withSourceQuery("/?table=42", 3)).toBe("/?table=42&source=3");
  });

  it("leaves the path untouched for the default source", () => {
    expect(withSourceQuery("/", null)).toBe("/");
  });

  it("appends with & when the path already has a query string", () => {
    expect(withSourceQuery("/erd?focus=1&label=dbo.orders", 5))
      .toBe("/erd?focus=1&label=dbo.orders&source=5");
  });
});
