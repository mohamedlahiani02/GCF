import { addDays, isoWeekday } from "@gcf/shared";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../../db/types.js";
import type { CwFormatNature } from "../../db/types.coworking.js";
import { unprocessable } from "../../errors.js";

export type Db = Kysely<Database> | Transaction<Database>;

/** Opening window of one local day, as HH:MM. */
export interface Opening {
  from: string;
  to: string;
}

export interface DayOpening {
  date: string;
  /** Null when the centre is closed that day. */
  open: Opening | null;
  /** Labels of the closures that apply to the day (closed or reduced hours). */
  closures: string[];
}

export const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
export const fromMinutes = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

export interface CentreCalendar {
  timezone: string;
  openFrom: string;
  openTo: string;
  openWeekdays: number[];
}

export async function centreCalendar(db: Db, centreId: string): Promise<CentreCalendar> {
  const row = await db.selectFrom("centres").select(["timezone", "open_from", "open_to", "open_weekdays"]).where("id", "=", centreId).executeTakeFirstOrThrow();
  return { timezone: row.timezone, openFrom: row.open_from.slice(0, 5), openTo: row.open_to.slice(0, 5), openWeekdays: row.open_weekdays };
}

/**
 * Opening of every day of a range (rule 1): the centre's weekdays and hours, replaced for a day by its closures.
 * A closure without hours closes the day; closures with hours only reduce it (the opening is the intersection of
 * the usual hours and every closure of the day), so a closure never opens a day or an hour the centre is closed.
 */
export async function openingsBetween(db: Db, centreId: string, from: string, to: string): Promise<DayOpening[]> {
  const calendar = await centreCalendar(db, centreId);
  const closures = await db
    .selectFrom("cw_closures")
    .select(["starts_on", "ends_on", "label", "open_from", "open_to"])
    .where("centre_id", "=", centreId)
    .where("starts_on", "<=", to)
    .where("ends_on", ">=", from)
    .execute();
  const days: DayOpening[] = [];
  for (let date = from, guard = 0; date <= to && guard < 1000; date = addDays(date, 1), guard += 1) {
    const applying = closures.filter((c) => c.starts_on <= date && c.ends_on >= date);
    const labels = applying.map((c) => c.label);
    if (!calendar.openWeekdays.includes(isoWeekday(date))) {
      days.push({ date, open: null, closures: labels });
      continue;
    }
    let start = toMinutes(calendar.openFrom);
    let end = toMinutes(calendar.openTo);
    for (const closure of applying) {
      if (closure.open_from === null || closure.open_to === null) {
        end = start;
        break;
      }
      start = Math.max(start, toMinutes(closure.open_from));
      end = Math.min(end, toMinutes(closure.open_to));
    }
    days.push({ date, open: end > start ? { from: fromMinutes(start), to: fromMinutes(end) } : null, closures: labels });
  }
  return days;
}

export async function openingOn(db: Db, centreId: string, date: string): Promise<DayOpening> {
  const [day] = await openingsBetween(db, centreId, date, date);
  return day!;
}

export interface FormatRule {
  nature: CwFormatNature;
  duration_minutes: number | null;
  start_step_minutes: number | null;
  start_time: string | null;
  end_time: string | null;
  min_minutes: number | null;
  max_minutes: number | null;
  weekdays: number[];
}

export interface LocalSlot {
  startTime: string;
  endTime: string;
  minutes: number;
}

/**
 * Checks the length asked for a free format: a multiple of its step between its minimum and maximum. Other
 * natures have their own length and ignore it.
 */
function freeDuration(format: FormatRule, durationMinutes: number | undefined): number {
  const step = format.start_step_minutes!;
  const duration = durationMinutes ?? format.min_minutes!;
  if (duration < format.min_minutes! || duration > format.max_minutes! || duration % step !== 0) {
    throw unprocessable("invalid_duration", `the duration must be a multiple of ${step} minutes between ${format.min_minutes} and ${format.max_minutes}`);
  }
  return duration;
}

/**
 * Start slots of a format on a day (rule 2), all inside the day's opening: fixed formats start every step from the
 * opening, named formats have their own hours, free formats start every step for the asked length (the minimum
 * when none is given). None on a weekday the format is not offered or a closed day.
 */
export function formatSlots(format: FormatRule, opening: Opening | null, date: string, durationMinutes?: number): LocalSlot[] {
  if (!opening || !format.weekdays.includes(isoWeekday(date))) return [];
  const open = toMinutes(opening.from);
  const close = toMinutes(opening.to);
  if (format.nature === "named") {
    const start = toMinutes(format.start_time!);
    const end = toMinutes(format.end_time!);
    return start >= open && end <= close ? [{ startTime: fromMinutes(start), endTime: fromMinutes(end), minutes: end - start }] : [];
  }
  const length = format.nature === "fixed" ? format.duration_minutes! : freeDuration(format, durationMinutes);
  const step = format.start_step_minutes!;
  const slots: LocalSlot[] = [];
  for (let start = open; start + length <= close; start += step) {
    slots.push({ startTime: fromMinutes(start), endTime: fromMinutes(start + length), minutes: length });
  }
  return slots;
}

export interface InstantSlot {
  startsAt: Date;
  endsAt: Date;
}

/** Local date and times of the centre converted to instants, in the same order. */
export async function localInstants(db: Db, timezone: string, items: { date: string; startTime: string; endTime: string }[]): Promise<InstantSlot[]> {
  if (items.length === 0) return [];
  const result = await sql<{ starts_at: Date; ends_at: Date }>`
    select (x.d + x.s) at time zone ${timezone} as starts_at, (x.d + x.e) at time zone ${timezone} as ends_at
    from unnest(${items.map((i) => i.date)}::date[], ${items.map((i) => i.startTime)}::time[], ${items.map((i) => i.endTime)}::time[])
      with ordinality as x(d, s, e, ord)
    order by x.ord`.execute(db);
  return result.rows.map((r) => ({ startsAt: r.starts_at, endsAt: r.ends_at }));
}

/** Booking rules of the centre. The row is created with its column defaults the first time it is needed. */
export async function coworkingSettings(db: Db, centreId: string) {
  await db
    .insertInto("cw_settings")
    .values({ centre_id: centreId })
    .onConflict((oc) => oc.column("centre_id").doNothing())
    .execute();
  const row = await db.selectFrom("cw_settings").selectAll().where("centre_id", "=", centreId).executeTakeFirstOrThrow();
  return { ...row, offpeak_from: row.offpeak_from === null ? null : row.offpeak_from.slice(0, 5) };
}

export type CoworkingSettings = Awaited<ReturnType<typeof coworkingSettings>>;
