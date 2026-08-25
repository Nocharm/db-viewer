import { describe, expect, it } from "vitest";

import { readSourceId, withSourceParam } from "./source-param";

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
