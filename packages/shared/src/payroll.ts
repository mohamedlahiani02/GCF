import { assertMillimes, mulDivRound, percentOf, type Millimes } from "./money.js";
import type { Rate } from "./attendance.js";

export class PayrollError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayrollError";
  }
}

/** Pay = Base x PresenceFactor. The base and the factor are each chosen by the rule that applies. */
export type PayBase =
  | { kind: "pct_collections"; basisPoints: number; collected: Millimes }
  | { kind: "pct_session_tariff"; basisPoints: number; sessionTariff: Millimes; sessionsHeld: number }
  | { kind: "fixed_per_session"; amountPerSession: Millimes; sessionsHeld: number }
  | { kind: "monthly_flat"; amount: Millimes }
  | { kind: "hourly"; hourlyRate: Millimes; minutesDelivered: number }
  | { kind: "training_flat"; amount: Millimes };

export type PresenceEffect =
  | { kind: "ignore" }
  | { kind: "prorata" }
  | { kind: "session_due" }
  | { kind: "threshold"; minRateBasisPoints: number; floor?: Millimes; prorataAbove: boolean };

export interface PayRule {
  base: PayBase;
  presence: PresenceEffect;
}

export interface PayComputation {
  base: Millimes;
  factor: Rate;
  amount: Millimes;
}

function assertCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PayrollError(`${label} must be a non-negative integer, received ${String(value)}`);
  }
}

export function computeBase(base: PayBase): Millimes {
  switch (base.kind) {
    case "pct_collections":
      assertMillimes(base.collected, "collected");
      return percentOf(base.collected, base.basisPoints);
    case "pct_session_tariff":
      assertCount(base.sessionsHeld, "sessionsHeld");
      assertMillimes(base.sessionTariff, "sessionTariff");
      return percentOf(base.sessionTariff * base.sessionsHeld, base.basisPoints);
    case "fixed_per_session":
      assertCount(base.sessionsHeld, "sessionsHeld");
      return assertMillimes(base.amountPerSession * base.sessionsHeld, "fixed pay");
    case "monthly_flat":
      return assertMillimes(base.amount, "monthly amount");
    case "hourly":
      assertCount(base.minutesDelivered, "minutesDelivered");
      return mulDivRound(base.hourlyRate, base.minutesDelivered, 60);
    case "training_flat":
      return assertMillimes(base.amount, "training amount");
  }
}

const FULL: Rate = { numerator: 1, denominator: 1 };

/** The presence factor as an exact fraction, so the amount is rounded exactly once. */
export function computeFactor(presence: PresenceEffect, rate: Rate): Rate {
  switch (presence.kind) {
    case "ignore":
    case "session_due":
      return FULL;
    case "prorata":
      return requireRate(rate);
    case "threshold": {
      const known = requireRate(rate);
      const below = known.numerator * 10_000 < presence.minRateBasisPoints * known.denominator;
      if (below) return { numerator: 0, denominator: 1 };
      return presence.prorataAbove ? known : FULL;
    }
  }
}

function requireRate(rate: Rate): Rate {
  if (rate.denominator <= 0) {
    throw new PayrollError("the attendance rate is undefined: no counted student sessions for this period");
  }
  return rate;
}

export function computePay(rule: PayRule, rate: Rate): PayComputation {
  const base = computeBase(rule.base);
  const factor = computeFactor(rule.presence, rate);
  let amount = mulDivRound(base, factor.numerator, factor.denominator);
  if (rule.presence.kind === "threshold" && factor.numerator === 0 && rule.presence.floor !== undefined) {
    amount = assertMillimes(rule.presence.floor, "floor");
  }
  return { base, factor, amount };
}
