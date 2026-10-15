import { describe, expect, it } from "vitest";
import { attendanceRate, rateToBasisPoints } from "./attendance.js";
import { computePay, PayrollError } from "./payroll.js";

describe("attendance rate", () => {
  it("counts present and make-up, not justified absences, by default", () => {
    const rate = attendanceRate(["present", "present", "absent", "absent_justified", "present_other_group"]);
    expect(rate).toEqual({ numerator: 3, denominator: 5 });
    expect(rateToBasisPoints(rate)).toBe(6000);
  });

  it("honours the settings", () => {
    const statuses = ["present", "absent_justified", "present_other_group"] as const;
    expect(attendanceRate(statuses, { countJustifiedAsPresent: true, countOtherGroupAsPresent: false })).toEqual({ numerator: 2, denominator: 3 });
  });

  it("has no basis points when nothing is counted", () => {
    expect(rateToBasisPoints(attendanceRate([]))).toBeUndefined();
  });
});

describe("pay = base x presence factor", () => {
  const rate85 = { numerator: 17, denominator: 20 };

  it("matches the reference example: 8 students x 40 = 320, share 60 % = 192, attendance 85 % = 163,200", () => {
    const result = computePay({ base: { kind: "pct_collections", basisPoints: 6000, collected: 320_000 }, presence: { kind: "prorata" } }, rate85);
    expect(result.base).toBe(192_000);
    expect(result.amount).toBe(163_200);
  });

  it("matches the legacy example: 8 sessions x 50 TND, attendance 70 %, prorata = 280", () => {
    const result = computePay(
      { base: { kind: "fixed_per_session", amountPerSession: 50_000, sessionsHeld: 8 }, presence: { kind: "prorata" } },
      { numerator: 7, denominator: 10 },
    );
    expect(result.amount).toBe(280_000);
  });

  it("ignores attendance when the rule says so", () => {
    const result = computePay({ base: { kind: "monthly_flat", amount: 405_000 }, presence: { kind: "ignore" } }, rate85);
    expect(result.amount).toBe(405_000);
  });

  it("pays nothing below the threshold, or the configured floor", () => {
    const low = { numerator: 2, denominator: 5 };
    const rule = (floor?: number) => ({
      base: { kind: "fixed_per_session" as const, amountPerSession: 40_000, sessionsHeld: 4 },
      presence: {
        kind: "threshold" as const,
        minRateBasisPoints: 5000,
        prorataAbove: false,
        ...(floor === undefined ? {} : { floor }),
      },
    });
    expect(computePay(rule(), low).amount).toBe(0);
    expect(computePay(rule(50_000), low).amount).toBe(50_000);
    expect(computePay(rule(), rate85).amount).toBe(160_000);
  });

  it("computes hourly pay from minutes", () => {
    const result = computePay({ base: { kind: "hourly", hourlyRate: 30_000, minutesDelivered: 90 }, presence: { kind: "session_due" } }, rate85);
    expect(result.amount).toBe(45_000);
  });

  it("refuses to prorate when no student sessions were counted", () => {
    expect(() => computePay({ base: { kind: "monthly_flat", amount: 100_000 }, presence: { kind: "prorata" } }, { numerator: 0, denominator: 0 })).toThrow(
      PayrollError,
    );
  });
});
