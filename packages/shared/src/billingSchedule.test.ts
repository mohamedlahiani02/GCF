import { describe, expect, it } from "vitest";
import { monthlyBillingDates, type BillingTiming } from "./schedule.js";

const rule = (monthlyDueKind: BillingTiming["monthlyDueKind"], monthlyDueDay: number | null = null, dueOffsetDays = 0): BillingTiming => ({
  monthlyDueKind,
  monthlyDueDay,
  dueOffsetDays,
});
describe("agreed monthly due dates", () => {
  it("keeps anniversary schedules, including January 31 and leap years", () => {
    expect(monthlyBillingDates("2028-01-31", "2028-03-31", rule("anniversary")).map((l) => l.dueDate)).toEqual(["2028-01-31", "2028-02-29", "2028-03-31"]);
  });
  it("includes the last partial service month for end-of-month billing", () => {
    expect(monthlyBillingDates("2026-09-15", "2026-12-15", rule("month_end"))).toEqual([
      { month: "2026-09", dueDate: "2026-09-30" },
      { month: "2026-10", dueDate: "2026-10-31" },
      { month: "2026-11", dueDate: "2026-11-30" },
      { month: "2026-12", dueDate: "2026-12-31" },
    ]);
  });
  it("never backdates the first payment and supports a chosen day with a delay", () => {
    expect(monthlyBillingDates("2026-09-15", "2026-10-15", rule("month_start")).map((l) => l.dueDate)).toEqual(["2026-09-15", "2026-10-01"]);
    expect(monthlyBillingDates("2028-02-01", "2028-03-01", rule("day_of_month", 31, 5))).toEqual([
      { month: "2028-02", dueDate: "2028-03-05" },
      { month: "2028-03", dueDate: "2028-04-05" },
    ]);
  });
  it("rejects missing custom days and invalid delays", () => {
    expect(() => monthlyBillingDates("2026-01-01", "2026-02-01", rule("day_of_month"))).toThrow();
    expect(() => monthlyBillingDates("2026-01-01", "2026-02-01", rule("month_end", null, -1))).toThrow();
  });
});
