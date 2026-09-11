import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "./relative-time";

describe("formatRelativeTime", () => {
  const now = new Date(2026, 8, 12, 9, 15);
  it("uses minutes and hours within the day", () => {
    expect(formatRelativeTime(new Date(2026, 8, 12, 9, 14, 40).toISOString(), now)).toBe("방금");
    expect(formatRelativeTime(new Date(2026, 8, 12, 9, 12).toISOString(), now)).toBe("3분 전");
    expect(formatRelativeTime(new Date(2026, 8, 12, 7, 15).toISOString(), now)).toBe("2시간 전");
  });
  it("names yesterday and falls back to a date", () => {
    expect(formatRelativeTime(new Date(2026, 8, 11, 18, 40).toISOString(), now)).toBe("어제 18:40");
    expect(formatRelativeTime(new Date(2026, 8, 9, 11, 30).toISOString(), now)).toBe("09-09 11:30");
  });
});
