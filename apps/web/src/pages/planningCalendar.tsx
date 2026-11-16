import { addDaysIso, frTime, localParts } from "../lib/format";
import type { PlanningItem } from "./groups";

export type Period = "day" | "week" | "month";

const DAY_NAMES = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const isoWeekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay() || 7;
const keyOf = (i: PlanningItem) => `${i.type}${i.id}`;

/** Monday of the week that contains the given day. */
export const weekStart = (iso: string): string => addDaysIso(iso, 1 - isoWeekday(iso));

/** The 42 days (six weeks, Monday first) shown by the month grid. */
export function monthGrid(iso: string): string[] {
  const first = `${iso.slice(0, 8)}01`;
  const start = weekStart(first);
  return Array.from({ length: 42 }, (_, n) => addDaysIso(start, n));
}

/** First and last day fetched for a period. */
export function periodRange(period: Period, iso: string): { from: string; to: string } {
  if (period === "week") {
    const from = weekStart(iso);
    return { from, to: addDaysIso(from, 6) };
  }
  if (period === "month") {
    const days = monthGrid(iso);
    return { from: days[0]!, to: days[days.length - 1]! };
  }
  return { from: iso, to: iso };
}

/** Moves the reference day by one period. */
export function shiftPeriod(period: Period, iso: string, direction: 1 | -1): string {
  if (period === "week") return addDaysIso(iso, 7 * direction);
  if (period === "month") {
    const [y, m] = [Number(iso.slice(0, 4)), Number(iso.slice(5, 7))];
    const month = m + direction;
    const year = month === 0 ? y - 1 : month === 13 ? y + 1 : y;
    const mm = month === 0 ? 12 : month === 13 ? 1 : month;
    return `${year}-${String(mm).padStart(2, "0")}-01`;
  }
  return addDaysIso(iso, direction);
}

export function periodTitle(period: Period, iso: string): string {
  if (period === "month") return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
  if (period === "week") {
    const from = weekStart(iso);
    const to = addDaysIso(from, 6);
    return `Semaine du ${from.split("-").reverse().join("/")} au ${to.split("-").reverse().join("/")}`;
  }
  return "";
}

/** Side-by-side lanes for items of one day that overlap, as a calendar does. */
function lanes(items: PlanningItem[]): Map<string, { lane: number; count: number }> {
  const sorted = [...items].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const result = new Map<string, { lane: number; count: number }>();
  let cluster: PlanningItem[] = [];
  let clusterEnd = "";
  const flush = () => {
    const ends: string[] = [];
    const placed: { key: string; lane: number }[] = [];
    for (const item of cluster) {
      let lane = ends.findIndex((end) => end <= item.startsAt);
      if (lane === -1) lane = ends.length;
      ends[lane] = item.endsAt;
      placed.push({ key: keyOf(item), lane });
    }
    for (const p of placed) result.set(p.key, { lane: p.lane, count: ends.length });
    cluster = [];
    clusterEnd = "";
  };
  for (const item of sorted) {
    if (cluster.length && item.startsAt >= clusterEnd) flush();
    cluster.push(item);
    if (item.endsAt > clusterEnd) clusterEnd = item.endsAt;
  }
  if (cluster.length) flush();
  return result;
}

interface ViewProps {
  date: string;
  items: PlanningItem[];
  clash: Set<string>;
  open: number;
  close: number;
  label: (i: PlanningItem) => string;
  blockClass: (i: PlanningItem) => string;
  onOpen: (i: PlanningItem) => void;
  onDay: (iso: string) => void;
}

const HOUR_PX = 48;

export function WeekView({ date, items, clash, open, close, label, blockClass, onOpen, onDay }: ViewProps) {
  const days = Array.from({ length: 7 }, (_, n) => addDaysIso(weekStart(date), n));
  const today = localParts(new Date()).date;
  const hours: number[] = [];
  for (let m = Math.floor(open / 60) * 60; m < close; m += 60) hours.push(m);
  const top = hours[0] ?? open;
  const height = ((close - top) / 60) * HOUR_PX;
  return (
    <div className="xs">
      <div className="cal-week" style={{ minWidth: 900 }}>
        <div className="cal-week-head">
          <div />
          {days.map((d, n) => (
            <button type="button" key={d} className={`cal-day-head${d === today ? " is-today" : ""}`} onClick={() => onDay(d)}>
              <span className="cap">{DAY_NAMES[n]}</span>
              <strong className="num">{Number(d.slice(8))}</strong>
            </button>
          ))}
        </div>
        <div className="cal-week-body" style={{ height }}>
          <div className="cal-hours">
            {hours.map((m) => (
              <span key={m} className="cap num" style={{ top: ((m - top) / 60) * HOUR_PX }}>
                {m / 60}h
              </span>
            ))}
          </div>
          {days.map((d) => {
            const dayItems = items.filter((i) => localParts(i.startsAt).date === d);
            const placed = lanes(dayItems);
            return (
              <div key={d} className="cal-col">
                {hours.map((m) => (
                  <div key={m} className="cal-slot" style={{ top: ((m - top) / 60) * HOUR_PX, height: HOUR_PX }} />
                ))}
                {dayItems.map((i) => {
                  const start = Math.max(top, minutesOf(localParts(i.startsAt).time));
                  const end = Math.min(close, minutesOf(localParts(i.endsAt).time) || close);
                  const lane = placed.get(keyOf(i)) ?? { lane: 0, count: 1 };
                  return (
                    <button
                      key={keyOf(i)}
                      type="button"
                      className={`${blockClass(i)} cal-event`}
                      style={{
                        top: ((start - top) / 60) * HOUR_PX,
                        height: Math.max(22, ((end - start) / 60) * HOUR_PX - 2),
                        left: `${(lane.lane / lane.count) * 100}%`,
                        width: `${100 / lane.count}%`,
                      }}
                      title={`${frTime(i.startsAt)}-${frTime(i.endsAt)} · ${label(i)}`}
                      onClick={() => onOpen(i)}
                    >
                      <div style={{ fontWeight: 600 }}>{label(i)}</div>
                      <div>
                        {clash.has(keyOf(i)) ? "Conflit · " : ""}
                        {frTime(i.startsAt)}-{frTime(i.endsAt)}
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const MONTH_CELL_LIMIT = 3;

export function MonthView({ date, items, clash, label, blockClass, onOpen, onDay }: ViewProps) {
  const days = monthGrid(date);
  const month = date.slice(0, 7);
  const today = localParts(new Date()).date;
  return (
    <div className="xs">
      <div className="cal-month" style={{ minWidth: 760 }}>
        {DAY_NAMES.map((n) => (
          <div key={n} className="cal-month-name cap">
            {n}
          </div>
        ))}
        {days.map((d) => {
          const dayItems = items.filter((i) => localParts(i.startsAt).date === d).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
          const extra = dayItems.length - MONTH_CELL_LIMIT;
          return (
            <div key={d} className={`cal-cell${d.slice(0, 7) === month ? "" : " is-out"}${d === today ? " is-today" : ""}`}>
              <button type="button" className="cal-cell-day num" onClick={() => onDay(d)}>
                {Number(d.slice(8))}
              </button>
              {dayItems.slice(0, MONTH_CELL_LIMIT).map((i) => (
                <button key={keyOf(i)} type="button" className={`${blockClass(i)} cal-chip`} title={label(i)} onClick={() => onOpen(i)}>
                  <span className="num">{frTime(i.startsAt)}</span> {clash.has(keyOf(i)) ? "Conflit · " : ""}
                  {label(i)}
                </button>
              ))}
              {extra > 0 ? (
                <button type="button" className="cal-more" onClick={() => onDay(d)}>
                  + {extra} autre{extra > 1 ? "s" : ""}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
