import { formatTnd, parseTnd } from "@gcf/shared";

export const tnd = (millimes: number | null | undefined) => (millimes === null || millimes === undefined ? "" : formatTnd(millimes, "fr"));
export { parseTnd };

const WEEKDAYS = ["", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
export const weekdayLabel = (iso: number) => WEEKDAYS[iso] ?? "";

/** The centre's time zone (centre settings). Every date and time on screen is shown in it, whatever the browser's zone. */
let TZ = "Africa/Tunis";
export function setTimeZone(timeZone: string): void {
  TZ = timeZone;
}
export const centreTimeZone = () => TZ;

export function frDate(value: string | Date | null | undefined): string {
  if (!value) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split("-").reverse().join("/");
  return new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
}

export function frTime(value: string | Date): string {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function frDateTime(value: string | Date | null | undefined): string {
  if (!value) return "";
  return `${frDate(value)} ${frTime(value)}`;
}

export function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function percent(basisPoints: number | null | undefined): string {
  if (basisPoints === null || basisPoints === undefined) return "-";
  return `${(basisPoints / 100).toFixed(basisPoints % 100 === 0 ? 0 : 1).replace(".", ",")} %`;
}

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
export const monthLabel = (isoMonthOrDate: string) => `${MONTHS[Number(isoMonthOrDate.slice(5, 7)) - 1]} ${isoMonthOrDate.slice(0, 4)}`;

/** Parses a typed amount; returns null when the text is not a valid TND amount. */
export function tryParseTnd(text: string): number | null {
  try {
    return text.trim() === "" ? null : parseTnd(text);
  } catch {
    return null;
  }
}

/** ISO instant with the centre's UTC offset for a local date and time, e.g. "2026-10-15T17:00:00+01:00". */
export function zonedIso(date: string, time: string): string {
  const probe = new Date(`${date}T${time}:00Z`);
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" }).formatToParts(probe).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const offset = name === "GMT" ? "+00:00" : name.slice(3);
  return `${date}T${time}:00${offset}`;
}

/** Local date (YYYY-MM-DD) and time (HH:MM) of an instant in the centre's time zone. */
export function localParts(value: string | Date): { date: string; time: string } {
  const d = new Date(value);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return { date, time };
}

export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
