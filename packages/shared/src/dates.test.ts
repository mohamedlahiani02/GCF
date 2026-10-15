import { describe, expect, it } from "vitest";
import { isIsoDate, isMinor, todayIn } from "./dates.js";

describe("dates", () => {
  it("validates real calendar dates only", () => {
    expect(isIsoDate("2026-10-15")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("15/10/2026")).toBe(false);
  });

  it("computes minority on the exact birthday boundary", () => {
    expect(isMinor("2008-10-15", "2026-10-14", 18)).toBe(true);
    expect(isMinor("2008-10-15", "2026-10-15", 18)).toBe(false);
    expect(isMinor("2008-02-29", "2026-02-28", 18)).toBe(true);
    expect(isMinor("2008-02-29", "2026-03-01", 18)).toBe(false);
  });

  it("reads today in the centre time zone", () => {
    expect(todayIn("Africa/Tunis", new Date("2026-10-15T23:30:00Z"))).toBe("2026-10-16");
  });
});
