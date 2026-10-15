/**
 * Money is always an integer count of the smallest unit (millimes for TND, which has 3 decimals).
 * Floating point is never used for amounts.
 */

export type Millimes = number;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export function assertMillimes(value: number, label = "amount"): Millimes {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} must be a safe integer count of millimes, received ${String(value)}`);
  }
  return value;
}

/** a * numerator / denominator, rounded half away from zero, computed with BigInt to avoid overflow. */
export function mulDivRound(a: Millimes, numerator: number, denominator: number): Millimes {
  assertMillimes(a, "a");
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new MoneyError("numerator and denominator must be safe integers");
  }
  if (denominator === 0) throw new MoneyError("denominator must not be zero");
  const negative = a < 0 !== numerator < 0 !== denominator < 0;
  const product = BigInt(Math.abs(a)) * BigInt(Math.abs(numerator));
  const den = BigInt(Math.abs(denominator));
  const quotient = product / den;
  const remainder = product % den;
  const rounded = remainder * 2n >= den ? quotient + 1n : quotient;
  const result = Number(negative ? -rounded : rounded);
  return assertMillimes(result, "result");
}

/** Percentage expressed in basis points (1 % = 100 bp, 60 % = 6000 bp). */
export function percentOf(amount: Millimes, basisPoints: number): Millimes {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new MoneyError("basisPoints must be a non-negative integer");
  }
  return mulDivRound(amount, basisPoints, 10_000);
}

/**
 * Splits `total` across `weights` using the largest remainder method so the parts always sum to `total`.
 * Ties on the remainder go to the earliest index, which keeps the output deterministic.
 */
export function allocate(total: Millimes, weights: readonly number[]): Millimes[] {
  assertMillimes(total, "total");
  if (weights.length === 0) throw new MoneyError("weights must not be empty");
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) {
    throw new MoneyError("weights must be non-negative safe integers");
  }
  const weightSum = weights.reduce((s, w) => s + w, 0);
  if (weightSum === 0) throw new MoneyError("weights must not all be zero");
  const sign = total < 0 ? -1 : 1;
  const abs = BigInt(Math.abs(total));
  const sum = BigInt(weightSum);
  const base = weights.map((w) => (abs * BigInt(w)) / sum);
  const remainders = weights.map((w, i) => ({ i, r: (abs * BigInt(w)) % sum }));
  let leftover = abs - base.reduce((s, b) => s + b, 0n);
  remainders.sort((x, y) => (x.r === y.r ? x.i - y.i : x.r > y.r ? -1 : 1));
  for (const { i } of remainders) {
    if (leftover === 0n) break;
    base[i] = (base[i] ?? 0n) + 1n;
    leftover -= 1n;
  }
  return base.map((b) => sign * Number(b));
}

const PLAIN_DECIMAL = /^\d+(?:[.,]\d+)?$/;
const NBSP = String.fromCharCode(0x00a0);
const NARROW_NBSP = String.fromCharCode(0x202f);
const GROUP_SPACE_CLASS = `[ ${NBSP}${NARROW_NBSP}]`;
const GROUPED_DECIMAL = new RegExp(`^\\d{1,3}(?:${GROUP_SPACE_CLASS}\\d{3})+(?:[.,]\\d+)?$`);
const GROUP_SPACES = new RegExp(GROUP_SPACE_CLASS, "g");

/** Parses a user-entered decimal string ("163,200", "1 250.5") into millimes. Rejects more than 3 decimals. */
export function parseTnd(input: string): Millimes {
  const trimmed = input.trim();
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  if (!PLAIN_DECIMAL.test(unsigned) && !GROUPED_DECIMAL.test(unsigned)) {
    throw new MoneyError(`not a valid amount: "${input}"`);
  }
  const normalized = unsigned.replace(GROUP_SPACES, "").replace(",", ".");
  const [whole = "0", fraction = ""] = normalized.split(".");
  if (fraction.length > 3) throw new MoneyError(`TND has at most 3 decimals: "${input}"`);
  const millimes = Number(whole) * 1000 + Number(fraction.padEnd(3, "0"));
  assertMillimes(millimes);
  return negative ? -millimes : millimes;
}


/** Formats millimes as a fixed 3-decimal string, e.g. 163200 -> "163,200" (fr) or "163.200" (en). */
export function formatTnd(amount: Millimes, locale: "fr" | "en" = "fr"): string {
  assertMillimes(amount);
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const whole = Math.trunc(abs / 1000);
  const fraction = String(abs % 1000).padStart(3, "0");
  const groupSeparator = locale === "fr" ? NARROW_NBSP : ",";
  const decimalSeparator = locale === "fr" ? "," : ".";
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, groupSeparator);
  return `${negative ? "-" : ""}${grouped}${decimalSeparator}${fraction}`;
}
