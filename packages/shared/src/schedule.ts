import { allocate, assertMillimes, percentOf, type Millimes } from "./money.js";
import { isIsoDate } from "./dates.js";

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

function parts(date: string): [number, number, number] {
  if (!isIsoDate(date)) throw new ScheduleError(`invalid date: ${date}`);
  return [Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10))];
}

function format(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Same day of month `months` later, clamped to the last day (31 Jan + 1 month = 28 or 29 Feb). */
export function addMonthsClamped(date: string, months: number, dayOfMonth?: number): string {
  const [y, m, d] = parts(date);
  const index = y * 12 + (m - 1) + months;
  const ny = Math.floor(index / 12);
  const nm = (index % 12) + 1;
  return format(ny, nm, Math.min(dayOfMonth ?? d, daysInMonth(ny, nm)));
}

/** ISO weekday: Monday = 1 ... Sunday = 7. */
export function isoWeekday(date: string): number {
  const [y, m, d] = parts(date);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * Monthly due dates from `firstDue` up to and including `lastDate`, keeping the day of month of `firstDue`
 * (clamped in shorter months).
 */
export function monthlyDueDates(firstDue: string, lastDate: string): string[] {
  if (lastDate < firstDue) return [];
  const day = parts(firstDue)[2];
  const dates: string[] = [];
  for (let i = 0; ; i += 1) {
    const next = addMonthsClamped(firstDue, i, day);
    if (next > lastDate) break;
    dates.push(next);
    if (i > 600) throw new ScheduleError("schedule longer than 50 years");
  }
  return dates;
}

export interface PlanItemInput {
  label: string;
  valueKind: "percent" | "amount";
  /** basis points when percent, millimes when amount */
  value: number;
  dueKind: "relative" | "fixed";
  dueOffsetDays?: number | null;
  dueDate?: string | null;
}

export interface PlanLine {
  label: string;
  amount: Millimes;
  dueDate: string;
}

/**
 * Turns plan items into amounts for a given price. Percent items are split with the largest remainder method,
 * so a plan made only of percentages summing to 100 % always totals the price exactly.
 * The result must equal the price, otherwise the plan is rejected.
 */
export function planAmounts(price: Millimes, items: readonly PlanItemInput[]): Millimes[] {
  assertMillimes(price, "price");
  if (items.length === 0) throw new ScheduleError("a payment plan needs at least one instalment");
  for (const item of items) {
    if (!Number.isSafeInteger(item.value) || item.value <= 0) throw new ScheduleError("every instalment value must be positive");
  }
  const percents = items.filter((i) => i.valueKind === "percent");
  const fixedTotal = items.filter((i) => i.valueKind === "amount").reduce((s, i) => s + i.value, 0);
  const percentTotalBp = percents.reduce((s, i) => s + i.value, 0);

  let percentAmounts: Millimes[];
  if (percents.length > 0 && fixedTotal === 0 && percentTotalBp === 10_000) {
    percentAmounts = allocate(
      price,
      percents.map((p) => p.value),
    );
  } else {
    percentAmounts = percents.map((p) => percentOf(price, p.value));
  }
  let cursor = 0;
  const amounts = items.map((item) => (item.valueKind === "amount" ? item.value : (percentAmounts[cursor++] as number)));
  const total = amounts.reduce((s, a) => s + a, 0);
  if (total !== price) {
    throw new ScheduleError(`instalments total ${total} millimes but the price is ${price} millimes`);
  }
  return amounts;
}

/** Plan lines for an enrolment starting on `enrolmentDate`. */
export function planLines(price: Millimes, items: readonly PlanItemInput[], enrolmentDate: string): PlanLine[] {
  const amounts = planAmounts(price, items);
  return items.map((item, index) => {
    let dueDate: string;
    if (item.dueKind === "relative") {
      if (item.dueOffsetDays === undefined || item.dueOffsetDays === null) throw new ScheduleError("relative instalment without offset");
      dueDate = addDays(enrolmentDate, item.dueOffsetDays);
    } else {
      if (!item.dueDate) throw new ScheduleError("fixed instalment without date");
      dueDate = item.dueDate;
    }
    return { label: item.label, amount: amounts[index] as number, dueDate };
  });
}
