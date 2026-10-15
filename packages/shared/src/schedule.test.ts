import { describe, expect, it } from "vitest";
import { addMonthsClamped, isoWeekday, monthlyDueDates, planAmounts, planLines, ScheduleError } from "./schedule.js";

describe("dates for schedules", () => {
  it("clamps to the end of shorter months", () => {
    expect(addMonthsClamped("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsClamped("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonthsClamped("2026-11-15", 2)).toBe("2027-01-15");
  });

  it("lists monthly due dates keeping the original day", () => {
    expect(monthlyDueDates("2026-10-31", "2027-01-31")).toEqual(["2026-10-31", "2026-11-30", "2026-12-31", "2027-01-31"]);
    expect(monthlyDueDates("2026-10-05", "2026-10-04")).toEqual([]);
  });

  it("returns ISO weekdays", () => {
    expect(isoWeekday("2026-10-12")).toBe(1);
    expect(isoWeekday("2026-10-18")).toBe(7);
  });
});

describe("payment plans", () => {
  it("splits 40 / 30 / 30 exactly", () => {
    const items = [4000, 3000, 3000].map((value, i) => ({
      label: `T${i + 1}`,
      valueKind: "percent" as const,
      value,
      dueKind: "relative" as const,
      dueOffsetDays: i * 21,
    }));
    expect(planAmounts(450_000, items)).toEqual([180_000, 135_000, 135_000]);
  });

  it("keeps a thirds plan exact to the millime", () => {
    const thirds = [3334, 3333, 3333].map((value) => ({ label: "x", valueKind: "percent" as const, value, dueKind: "relative" as const, dueOffsetDays: 0 }));
    const amounts = planAmounts(100_000, thirds);
    expect(amounts.reduce((s, a) => s + a, 0)).toBe(100_000);
  });

  it("rejects a plan whose total differs from the price", () => {
    const items = [4000, 3000, 2000].map((value) => ({ label: "x", valueKind: "percent" as const, value, dueKind: "relative" as const, dueOffsetDays: 0 }));
    expect(() => planAmounts(450_000, items)).toThrow(ScheduleError);
  });

  it("accepts mixed amounts and percentages when they add up", () => {
    const amounts = planAmounts(450_000, [
      { label: "Inscription", valueKind: "amount", value: 50_000, dueKind: "relative", dueOffsetDays: 0 },
      { label: "Solde", valueKind: "amount", value: 400_000, dueKind: "fixed", dueDate: "2026-12-15" },
    ]);
    expect(amounts).toEqual([50_000, 400_000]);
  });

  it("computes due dates relative to the enrolment or fixed", () => {
    const lines = planLines(
      450_000,
      [
        { label: "Tranche 1", valueKind: "percent", value: 4000, dueKind: "relative", dueOffsetDays: 0 },
        { label: "Tranche 2", valueKind: "percent", value: 3000, dueKind: "relative", dueOffsetDays: 21 },
        { label: "Tranche 3", valueKind: "percent", value: 3000, dueKind: "fixed", dueDate: "2026-12-15" },
      ],
      "2026-11-03",
    );
    expect(lines.map((l) => l.dueDate)).toEqual(["2026-11-03", "2026-11-24", "2026-12-15"]);
  });
});
