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

/**
 * How student attendance affects pay. Whether a cancelled session, or a held session with no student present, is
 * paid at all is a separate setting of the rule, applied before this effect (see `computePay`).
 * - ignore: attendance plays no role (100 %).
 * - prorata: pay x attendance rate.
 * - session_due: former option that behaves exactly as `ignore`; kept so rules created with it still compute.
 * - threshold: no pay (or the floor) below the minimum rate; full pay, or prorata if enabled, above it.
 */
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
  /** Base of the sessions held, before the presence factor. */
  base: Millimes;
  factor: Rate;
  /** Pay for cancelled sessions the rule pays; attendance does not apply to them. Included in `amount`. */
  cancelledPay: Millimes;
  amount: Millimes;
}

/** Cancelled sessions a rule pays: counted like held sessions in a base per session or per hour, at 100 %. */
export interface PaidCancellations {
  sessions: number;
  minutes: number;
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

/** The same base, counting the given sessions instead of the held ones. Only bases counted per session or per hour have one. */
function cancellationBase(base: PayBase, cancelled: PaidCancellations): PayBase {
  switch (base.kind) {
    case "pct_session_tariff":
    case "fixed_per_session":
      return { ...base, sessionsHeld: cancelled.sessions };
    case "hourly":
      return { ...base, minutesDelivered: cancelled.minutes };
    default:
      throw new Error(`cancelled sessions cannot be paid with a ${base.kind} base`);
  }
}

/** True when a base counted per session or per hour has no held session to pay, so no attendance is needed. */
function nothingHeld(base: PayBase): boolean {
  switch (base.kind) {
    case "pct_session_tariff":
    case "fixed_per_session":
      return base.sessionsHeld === 0;
    case "hourly":
      return base.minutesDelivered === 0;
    default:
      return false;
  }
}

/**
 * Pay = Base x PresenceFactor for the sessions held, plus the base of the cancelled sessions the rule pays.
 * When only cancelled sessions are paid, no attendance rate is needed.
 */
export function computePay(rule: PayRule, rate: Rate, cancelled: PaidCancellations = { sessions: 0, minutes: 0 }): PayComputation {
  assertCount(cancelled.sessions, "cancelled sessions");
  assertCount(cancelled.minutes, "cancelled minutes");
  const hasCancelled = cancelled.sessions > 0;
  const cancelledPay = hasCancelled ? computeBase(cancellationBase(rule.base, cancelled)) : 0;
  const base = computeBase(rule.base);
  if (hasCancelled && nothingHeld(rule.base)) {
    return { base, factor: FULL, cancelledPay, amount: assertMillimes(base + cancelledPay, "pay") };
  }
  const factor = computeFactor(rule.presence, rate);
  let held = mulDivRound(base, factor.numerator, factor.denominator);
  if (rule.presence.kind === "threshold" && factor.numerator === 0 && rule.presence.floor !== undefined) {
    held = assertMillimes(rule.presence.floor, "floor");
  }
  return { base, factor, cancelledPay, amount: assertMillimes(held + cancelledPay, "pay") };
}
