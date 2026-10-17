import { formatTnd } from "@gcf/shared";
import { DICTIONARIES } from "../i18n/dictionary";
import { useI18n, type Language } from "../i18n/i18n";

/**
 * Time zone used for instants (payments, mail, cancellation deadlines): the centre's, from GET /info, whatever the
 * browser's zone. Booking dates and times already arrive local to the centre.
 */
let timeZone = "Africa/Tunis";
export function setTimeZone(zone: string): void {
  timeZone = zone;
}

/** Money is integer millimes, shown as TND with 3 decimals in the reader's language. */
const money = (millimes: number, language: Language) => `${formatTnd(millimes, language)} TND`;

/** A local calendar date (YYYY-MM-DD) with its weekday, e.g. "mer. 21/10/2026". */
function calendarDate(date: string, language: Language, withWeekday = false): string {
  return new Intl.DateTimeFormat(DICTIONARIES[language].locale, {
    timeZone: "UTC",
    ...(withWeekday ? { weekday: "short" } : {}),
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(`${date}T00:00:00Z`));
}

/** An instant as date and time in the centre's time zone. */
function dateTime(instant: string, language: Language): string {
  return new Intl.DateTimeFormat(DICTIONARIES[language].locale, {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(instant));
}

/** An instant as a date in the centre's time zone. */
function instantDate(instant: string, language: Language): string {
  return new Intl.DateTimeFormat(DICTIONARIES[language].locale, { timeZone, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(instant));
}

export const minutesText = (minutes: number, language: Language) => DICTIONARIES[language].duration.hours(Math.floor(minutes / 60), minutes % 60);

/** Basis points as a percentage, e.g. 5000 -> "50 %" (fr) or "50%" (en). */
function percent(basisPoints: number, language: Language): string {
  const value = (basisPoints / 100).toFixed(basisPoints % 100 === 0 ? 0 : 1);
  return language === "fr" ? `${value.replace(".", ",")} %` : `${value}%`;
}

/** The formatting helpers bound to the current language. */
export function useFormat() {
  const { language } = useI18n();
  return {
    money: (millimes: number) => money(millimes, language),
    date: (date: string, withWeekday = false) => calendarDate(date, language, withWeekday),
    dateTime: (instant: string) => dateTime(instant, language),
    instantDate: (instant: string) => instantDate(instant, language),
    minutes: (minutes: number) => minutesText(minutes, language),
    percent: (basisPoints: number) => percent(basisPoints, language),
  };
}
