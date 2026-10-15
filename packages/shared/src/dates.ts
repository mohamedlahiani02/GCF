const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Validates a calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return date.toISOString().slice(0, 10) === value;
}

/** Today's calendar date in the given IANA time zone, as YYYY-MM-DD. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** True when the person born on `birthDate` has not reached `majorityAge` on `onDate` (both YYYY-MM-DD). */
export function isMinor(birthDate: string, onDate: string, majorityAge: number): boolean {
  if (!isIsoDate(birthDate) || !isIsoDate(onDate)) throw new Error("dates must be valid YYYY-MM-DD values");
  const birthYear = Number(birthDate.slice(0, 4));
  const majorityDay = `${String(birthYear + majorityAge).padStart(4, "0")}${birthDate.slice(4)}`;
  // A birthday on 29 February reaches majority on 1 March in non-leap years: string comparison handles it,
  // because "YYYY-02-29" sorts after "YYYY-02-28" and before "YYYY-03-01".
  return onDate < majorityDay;
}
