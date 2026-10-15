import { addMonthsClamped, isoWeekday, addDays, mulDivRound } from "@gcf/shared";
import type { RentalUnit } from "../db/types.js";
import { unprocessable } from "../errors.js";

export interface SlotInstant {
  startsAt: Date;
  endsAt: Date;
}

export interface Pricing {
  unitPrice: number;
  /** Billable quantity: minutes for an hourly rate, slots for half-days and days, months or years otherwise. */
  quantity: number;
  total: number;
}

/** The price comes from the room's tariff grid; it is never typed in by hand. */
export function priceRental(rates: Map<RentalUnit, number>, unit: RentalUnit, slots: SlotInstant[], periods: number | undefined): Pricing {
  const unitPrice = rates.get(unit);
  if (unitPrice === undefined) throw unprocessable("no_tariff", `the room has no ${unit} tariff`);
  if (slots.length === 0) throw unprocessable("no_slot", "a rental needs at least one slot");
  switch (unit) {
    case "hour": {
      const minutes = slots.reduce((s, x) => s + Math.round((x.endsAt.getTime() - x.startsAt.getTime()) / 60_000), 0);
      return { unitPrice, quantity: minutes, total: mulDivRound(unitPrice, minutes, 60) };
    }
    case "half_day":
    case "day":
      return { unitPrice, quantity: slots.length, total: unitPrice * slots.length };
    case "month":
    case "year":
      if (!periods || periods < 1) throw unprocessable("periods_required", `give the number of ${unit === "month" ? "months" : "years"}`);
      return { unitPrice, quantity: periods, total: unitPrice * periods };
  }
}

export interface WeeklyPattern {
  from: string;
  to: string;
  weekdays: number[];
  startTime: string;
  endTime: string;
}

/** Local calendar slots of a weekly pattern; converted to instants in the centre time zone by the caller. */
export function expandPattern(pattern: WeeklyPattern): { date: string; startTime: string; endTime: string }[] {
  if (pattern.to < pattern.from) throw unprocessable("invalid_range", "the end date cannot be before the start date");
  const out: { date: string; startTime: string; endTime: string }[] = [];
  for (let date = pattern.from, guard = 0; date <= pattern.to; date = addDays(date, 1), guard += 1) {
    if (guard > 800) throw unprocessable("range_too_long", "a rental pattern covers at most two years");
    if (pattern.weekdays.includes(isoWeekday(date))) out.push({ date, startTime: pattern.startTime, endTime: pattern.endTime });
  }
  if (out.length > 400) throw unprocessable("too_many_slots", "a rental has at most 400 slots");
  return out;
}

export interface RentalLine {
  label: string;
  amount: number;
  dueDate: string;
}

/** Instalments of a rental: in full now, deposit now and balance on the first day, or one per month or year. */
export function rentalSchedule(
  pricing: Pricing,
  unit: RentalUnit,
  mode: "full" | "deposit_balance" | "recurring",
  today: string,
  firstDay: string,
  roomName: string,
  deposit: number | undefined,
): RentalLine[] {
  const label = `Location ${roomName}`;
  if (mode === "full") return [{ label: `${label}, paiement intégral`, amount: pricing.total, dueDate: today }];
  if (mode === "deposit_balance") {
    if (deposit === undefined || deposit <= 0 || deposit >= pricing.total)
      throw unprocessable("invalid_deposit", "the deposit must be more than zero and less than the total");
    return [
      { label: `${label}, acompte`, amount: deposit, dueDate: today },
      { label: `${label}, solde`, amount: pricing.total - deposit, dueDate: firstDay > today ? firstDay : today },
    ];
  }
  if (unit !== "month" && unit !== "year") throw unprocessable("recurring_not_applicable", "recurring payment applies to monthly or yearly rentals");
  return Array.from({ length: pricing.quantity }, (_, i) => ({
    label: `${label}, ${unit === "month" ? "mois" : "année"} ${i + 1}/${pricing.quantity}`,
    amount: pricing.unitPrice,
    dueDate: addMonthsClamped(firstDay, unit === "month" ? i : i * 12),
  }));
}
