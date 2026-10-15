import { formatTnd, parseTnd } from "@gcf/shared";

export const tnd = (millimes: number | null | undefined) => (millimes === null || millimes === undefined ? "" : formatTnd(millimes, "fr"));
export { parseTnd };

const WEEKDAYS = ["", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
export const weekdayLabel = (iso: number) => WEEKDAYS[iso] ?? "";

const TZ = "Africa/Tunis";

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
