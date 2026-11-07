import { addDays, isoWeekday } from "./schedule.js";

/** When a scheduled automation runs, in the centre's local time. Weekday is ISO (Monday = 1 ... Sunday = 7). */
export type AutomationSchedule =
  { kind: "daily"; hour: number } | { kind: "weekly"; weekday: number; hour: number } | { kind: "monthly"; day: number; hour: number };

/** A moment as the centre sees it: its local date and hour. */
export interface LocalMoment {
  date: string;
  hour: number;
}

export function localMoment(timeZone: string, now: Date): LocalMoment {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

/**
 * The period a moment belongs to for a schedule, and whether that period's run is due. A period runs once: a day
 * for a daily schedule, an ISO week (named after its Monday) for a weekly one, a calendar month for a monthly one.
 * The run is due from its scheduled hour until the end of the period, so a server that was stopped at that hour
 * still runs it when it comes back within the period.
 */
export function automationPeriod(schedule: AutomationSchedule, moment: LocalMoment): { periodKey: string; due: boolean } {
  if (schedule.kind === "daily") return { periodKey: moment.date, due: moment.hour >= schedule.hour };
  if (schedule.kind === "weekly") {
    const weekday = isoWeekday(moment.date);
    return {
      periodKey: `week-${addDays(moment.date, 1 - weekday)}`,
      due: weekday > schedule.weekday || (weekday === schedule.weekday && moment.hour >= schedule.hour),
    };
  }
  const day = Number(moment.date.slice(8, 10));
  return { periodKey: moment.date.slice(0, 7), due: day > schedule.day || (day === schedule.day && moment.hour >= schedule.hour) };
}

/** The calendar month before a YYYY-MM month. */
export function previousMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1;
  const date = new Date(Date.UTC(year, index - 1, 1));
  return date.toISOString().slice(0, 7);
}
