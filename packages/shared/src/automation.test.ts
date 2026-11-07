import { describe, expect, it } from "vitest";
import { automationPeriod, localMoment, previousMonth } from "./automation.js";

describe("automation schedules", () => {
  it("reads the local date and hour of the centre", () => {
    // 23:30 UTC on 31 October is 00:30 on 1 November in Tunis (UTC+1).
    expect(localMoment("Africa/Tunis", new Date("2026-10-31T23:30:00Z"))).toEqual({ date: "2026-11-01", hour: 0 });
    expect(localMoment("UTC", new Date("2026-10-31T23:30:00Z"))).toEqual({ date: "2026-10-31", hour: 23 });
  });

  it("runs a daily schedule once a day from its hour", () => {
    expect(automationPeriod({ kind: "daily", hour: 18 }, { date: "2026-11-07", hour: 17 })).toEqual({ periodKey: "2026-11-07", due: false });
    expect(automationPeriod({ kind: "daily", hour: 18 }, { date: "2026-11-07", hour: 18 })).toEqual({ periodKey: "2026-11-07", due: true });
  });

  it("runs a weekly schedule from its weekday and hour until the end of the ISO week", () => {
    const monday9 = { kind: "weekly" as const, weekday: 1, hour: 9 };
    // 2026-11-02 is a Monday.
    expect(automationPeriod(monday9, { date: "2026-11-02", hour: 8 })).toEqual({ periodKey: "week-2026-11-02", due: false });
    expect(automationPeriod(monday9, { date: "2026-11-02", hour: 9 })).toEqual({ periodKey: "week-2026-11-02", due: true });
    expect(automationPeriod(monday9, { date: "2026-11-08", hour: 0 })).toEqual({ periodKey: "week-2026-11-02", due: true });
    const friday = { kind: "weekly" as const, weekday: 5, hour: 16 };
    expect(automationPeriod(friday, { date: "2026-11-05", hour: 20 })).toEqual({ periodKey: "week-2026-11-02", due: false });
    expect(automationPeriod(friday, { date: "2026-11-09", hour: 10 })).toEqual({ periodKey: "week-2026-11-09", due: false });
  });

  it("runs a monthly schedule from its day and hour until the end of the month", () => {
    const second7 = { kind: "monthly" as const, day: 2, hour: 7 };
    expect(automationPeriod(second7, { date: "2026-11-01", hour: 23 })).toEqual({ periodKey: "2026-11", due: false });
    expect(automationPeriod(second7, { date: "2026-11-02", hour: 7 })).toEqual({ periodKey: "2026-11", due: true });
    expect(automationPeriod(second7, { date: "2026-11-30", hour: 0 })).toEqual({ periodKey: "2026-11", due: true });
  });

  it("finds the previous month across a year", () => {
    expect(previousMonth("2026-11")).toBe("2026-10");
    expect(previousMonth("2027-01")).toBe("2026-12");
  });
});
