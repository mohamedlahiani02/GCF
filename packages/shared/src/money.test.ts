import { describe, expect, it } from "vitest";
import { allocate, formatTnd, MoneyError, mulDivRound, parseTnd, percentOf } from "./money.js";

describe("money", () => {
  it("parses TND strings with up to three decimals", () => {
    expect(parseTnd("163,200")).toBe(163_200);
    expect(parseTnd("163.2")).toBe(163_200);
    expect(parseTnd("1 250,5")).toBe(1_250_500);
    expect(parseTnd("-40")).toBe(-40_000);
    expect(parseTnd("0,001")).toBe(1);
  });

  it("rejects malformed amounts and more than three decimals", () => {
    expect(() => parseTnd("12,3456")).toThrow(MoneyError);
    expect(() => parseTnd("abc")).toThrow(MoneyError);
    expect(() => parseTnd("1,2,3")).toThrow(MoneyError);
    expect(() => parseTnd("")).toThrow(MoneyError);
  });

  it("formats with fixed three decimals", () => {
    expect(formatTnd(163_200, "en")).toBe("163.200");
    expect(formatTnd(1_250_500, "en")).toBe("1,250.500");
    expect(formatTnd(-1, "en")).toBe("-0.001");
    expect(formatTnd(1_250_500, "fr")).toBe("1\u202f250,500");
  });

  it("rounds half away from zero exactly once", () => {
    expect(mulDivRound(1, 1, 2)).toBe(1);
    expect(mulDivRound(-1, 1, 2)).toBe(-1);
    expect(mulDivRound(192_000, 17, 20)).toBe(163_200);
    expect(percentOf(320_000, 6000)).toBe(192_000);
  });

  it("allocates so that parts always sum to the total", () => {
    const parts = allocate(100, [1, 1, 1]);
    expect(parts).toEqual([34, 33, 33]);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(100);
    expect(allocate(-100, [1, 1, 1]).reduce((s, p) => s + p, 0)).toBe(-100);
    expect(allocate(450_000, [40, 30, 30])).toEqual([180_000, 135_000, 135_000]);
  });
});
