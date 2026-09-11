import { describe, expect, it } from "vitest";

import type { SourceOption } from "./api";
import { resolveSelectedSource, stepActiveIndex } from "./source-picker";

const SOURCES: SourceOption[] = [
  { id: 1, name: "사내 MSSQL", engine: "mssql", is_enabled: true },
  { id: 7, name: "svca", engine: "postgres", is_enabled: true },
];

describe("resolveSelectedSource", () => {
  it("returns the matching source", () => {
    expect(resolveSelectedSource(SOURCES, 7)?.id).toBe(7);
  });

  it("falls back to the first source for null or an unknown id", () => {
    expect(resolveSelectedSource(SOURCES, null)?.id).toBe(1);
    expect(resolveSelectedSource(SOURCES, 99)?.id).toBe(1);
  });

  it("returns null when there is nothing to pick", () => {
    expect(resolveSelectedSource([], null)).toBeNull();
  });
});

describe("stepActiveIndex", () => {
  it("moves and wraps in both directions", () => {
    expect(stepActiveIndex(0, 1, 3)).toBe(1);
    expect(stepActiveIndex(2, 1, 3)).toBe(0);
    expect(stepActiveIndex(0, -1, 3)).toBe(2);
  });

  it("enters the list from the matching end when nothing is active", () => {
    expect(stepActiveIndex(-1, 1, 3)).toBe(0);
    expect(stepActiveIndex(-1, -1, 3)).toBe(2);
  });

  it("stays out of an empty list", () => {
    expect(stepActiveIndex(0, 1, 0)).toBe(-1);
  });
});
