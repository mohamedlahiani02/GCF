import { vi } from "vitest";

/**
 * The fixed moment the suite runs at: Tuesday 20 October 2026, 09:00 in Tunis. Fixtures are written as dates around it
 * (September and early October in the past, late October and after in the future), so they keep their meaning
 * whatever the real date. Time still moves forward from there at the normal pace, so ordering and expiries behave.
 */
export const TEST_NOW = new Date("2026-10-20T08:00:00.000Z");

/** Milliseconds between the test clock and the real clock; the database clock is shifted by the same amount. */
export function testClockOffsetMs(): number {
  return Date.now() - vi.getRealSystemTime();
}

// Only Date is faked: timers, promises and I/O keep running for real.
vi.useFakeTimers({ toFake: ["Date"], now: TEST_NOW, shouldAdvanceTime: true });
