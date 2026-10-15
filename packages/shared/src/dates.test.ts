import { describe, expect, it } from "vitest";
import { isIsoDate, todayIn } from "./dates.js";

describe("dates", () => {
  it("validates real calendar dates only", () => {
    expect(isIsoDate("2026-10-15")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("15/10/2026")).toBe(false);
  });


  it("reads today in the centre time zone", () => {
    expect(todayIn("Africa/Tunis", new Date("2026-10-15T23:30:00Z"))).toBe("2026-10-16");
  });
});
