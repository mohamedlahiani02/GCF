import { isoWeekday, mulDivRound } from "@gcf/shared";
import { sql } from "kysely";
import type { CwCategory } from "../../db/types.coworking.js";
import { centreCalendar, coworkingSettings, openingsBetween, toMinutes, type Db } from "./schedule.js";

/** A period of local dates of the centre, both included. */
export interface StatsRange {
  from: string;
  to: string;
}

/** Statuses of bookings that held their resource: the base of occupancy, durations and lead times. */
const HELD = ["confirmed", "checked_in", "completed", "no_show"] as const;
const MONTHS_OF_PERIOD = { month: 1, quarter: 3, year: 12 } as const;

const rate = (part: number, whole: number) => (whole > 0 ? mulDivRound(part, 10_000, whole) : 0);

interface HeldBooking {
  resourceId: string;
  typeId: string;
  status: string;
  checkedIn: boolean;
  localDate: string;
  startMinute: number;
  endMinute: number;
  minutes: number;
}

async function heldBookings(db: Db, centreId: string, range: StatsRange, timezone: string): Promise<HeldBooking[]> {
  const localStart = sql<string>`(b.starts_at at time zone ${timezone})`;
  const rows = await db
    .selectFrom("cw_bookings as b")
    .innerJoin("cw_resources as r", "r.id", "b.resource_id")
    .select([
      "b.resource_id as resourceId",
      "r.type_id as typeId",
      "b.status",
      sql<boolean>`b.checked_in_at is not null`.as("checkedIn"),
      sql<string>`to_char(${localStart}, 'YYYY-MM-DD')`.as("localDate"),
      sql<number>`(extract(hour from ${localStart}) * 60 + extract(minute from ${localStart}))::integer`.as("startMinute"),
      sql<number>`round(extract(epoch from b.ends_at - b.starts_at) / 60)::integer`.as("minutes"),
    ])
    .where("b.centre_id", "=", centreId)
    .where("b.kind", "=", "booking")
    .where("b.status", "in", [...HELD])
    .where(sql<string>`${localStart}::date`, ">=", range.from)
    .where(sql<string>`${localStart}::date`, "<=", range.to)
    .execute();
  return rows.map((r) => ({ ...r, endMinute: Math.min(1440, r.startMinute + r.minutes) }));
}

const isUsed = (b: HeldBooking) => b.status === "checked_in" || (b.status === "completed" && b.checkedIn);

async function bookableResources(db: Db, centreId: string) {
  const rows = await db
    .selectFrom("cw_resources as r")
    .innerJoin("cw_resource_types as t", "t.id", "r.type_id")
    .select(["r.id", "r.code", "r.type_id as typeId", "t.name as typeName", "t.category", "t.position"])
    .where("r.centre_id", "=", centreId)
    .where("r.status", "!=", "archived")
    .orderBy("t.position")
    .orderBy("r.code")
    .execute();
  return rows.filter((r) => r.category !== "dedicated_desk" && r.category !== "private_office");
}

export interface ResourceOccupancy {
  resourceId: string;
  code: string;
  typeId: string;
  typeName: string;
  category: CwCategory;
  bookedMinutes: number;
  usedMinutes: number;
  /** Basis points of the open minutes of the period. */
  bookedRate: number;
  usedRate: number;
}

/**
 * Occupancy of each bookable resource: minutes booked (confirmed, checked in, completed or no-show) and used
 * (checked in, or completed with a check-in) against the open minutes of the period, opening hours minus closures.
 */
export async function occupancyByResource(db: Db, centreId: string, range: StatsRange): Promise<{ openMinutes: number; resources: ResourceOccupancy[] }> {
  const { timezone } = await centreCalendar(db, centreId);
  const openMinutes = (await openingsBetween(db, centreId, range.from, range.to)).reduce(
    (sum, d) => sum + (d.open ? toMinutes(d.open.to) - toMinutes(d.open.from) : 0),
    0,
  );
  const bookings = await heldBookings(db, centreId, range, timezone);
  const resources = (await bookableResources(db, centreId)).map((r) => {
    const own = bookings.filter((b) => b.resourceId === r.id);
    const bookedMinutes = own.reduce((s, b) => s + b.minutes, 0);
    const usedMinutes = own.filter(isUsed).reduce((s, b) => s + b.minutes, 0);
    return {
      resourceId: r.id,
      code: r.code,
      typeId: r.typeId,
      typeName: r.typeName,
      category: r.category,
      bookedMinutes,
      usedMinutes,
      bookedRate: rate(bookedMinutes, openMinutes),
      usedRate: rate(usedMinutes, openMinutes),
    };
  });
  return { openMinutes, resources };
}

export interface HeatmapCell {
  weekday: number;
  hour: number;
  bookedMinutes: number;
  /** Open minutes of that weekday and hour over the period, times the resources of the type. */
  capacityMinutes: number;
  rate: number;
}

export interface TypeHeatmap {
  typeId: string;
  typeName: string;
  resources: number;
  /** Only the weekday and hour cells the centre is open. */
  cells: HeatmapCell[];
}

/** Booked minutes per ISO weekday and hour of the day for each bookable resource type. */
export async function occupancyHeatmap(db: Db, centreId: string, range: StatsRange): Promise<TypeHeatmap[]> {
  const { timezone } = await centreCalendar(db, centreId);
  const days = await openingsBetween(db, centreId, range.from, range.to);
  const bookings = await heldBookings(db, centreId, range, timezone);
  const resources = await bookableResources(db, centreId);
  const openPerCell = new Map<string, number>();
  for (const day of days) {
    if (!day.open) continue;
    const from = toMinutes(day.open.from);
    const to = toMinutes(day.open.to);
    for (let hour = Math.floor(from / 60); hour * 60 < to; hour += 1) {
      const minutes = Math.min(to, hour * 60 + 60) - Math.max(from, hour * 60);
      const key = `${isoWeekday(day.date)}:${hour}`;
      openPerCell.set(key, (openPerCell.get(key) ?? 0) + minutes);
    }
  }
  const types = new Map<string, { typeName: string; resources: number }>();
  for (const r of resources) types.set(r.typeId, { typeName: r.typeName, resources: (types.get(r.typeId)?.resources ?? 0) + 1 });
  return [...types.entries()].map(([typeId, type]) => {
    const booked = new Map<string, number>();
    for (const b of bookings.filter((x) => x.typeId === typeId)) {
      const weekday = isoWeekday(b.localDate);
      for (let hour = Math.floor(b.startMinute / 60); hour * 60 < b.endMinute; hour += 1) {
        const minutes = Math.min(b.endMinute, hour * 60 + 60) - Math.max(b.startMinute, hour * 60);
        const key = `${weekday}:${hour}`;
        booked.set(key, (booked.get(key) ?? 0) + minutes);
      }
    }
    const cells = [...openPerCell.entries()]
      .map(([key, open]) => {
        const [weekday, hour] = key.split(":").map(Number) as [number, number];
        const bookedMinutes = booked.get(key) ?? 0;
        const capacityMinutes = open * type.resources;
        return { weekday, hour, bookedMinutes, capacityMinutes, rate: rate(bookedMinutes, capacityMinutes) };
      })
      .sort((a, b) => a.weekday - b.weekday || a.hour - b.hour);
    return { typeId, typeName: type.typeName, resources: type.resources, cells };
  });
}

export interface RevenueLine {
  source: "bookings" | "subscriptions" | "packs";
  /** Resource type of the booking or pack, or the type a subscription plan assigns; null for other plans. */
  typeId: string | null;
  typeName: string | null;
  /** Charges due in the period that are not cancelled. */
  issued: number;
  /** Payments allocated to coworking charges, by payment date. */
  collected: number;
}

const SOURCE = sql<
  RevenueLine["source"]
>`case when i.cw_booking_id is not null then 'bookings' when i.cw_subscription_id is not null then 'subscriptions' else 'packs' end`;
const TYPE = sql<string | null>`coalesce(r.type_id, p.type_id, pl.assigned_type_id)`;
const OWNERS = sql`left join cw_bookings b on b.id = i.cw_booking_id
  left join cw_resources r on r.id = b.resource_id
  left join cw_packs p on p.id = i.cw_pack_id
  left join cw_subscriptions s on s.id = i.cw_subscription_id
  left join cw_plans pl on pl.id = s.plan_id`;

/** Coworking revenue issued (charges by due date) and collected (effective allocations by payment date) per source and type. */
export async function revenueByType(db: Db, centreId: string, range: StatsRange): Promise<RevenueLine[]> {
  const { timezone } = await centreCalendar(db, centreId);
  const issued = await sql<{ source: RevenueLine["source"]; type_id: string | null; amount: number }>`
    select ${SOURCE} as source, ${TYPE} as type_id, sum(i.amount)::bigint as amount
    from installments i ${OWNERS}
    where i.centre_id = ${centreId} and i.member_id is not null and i.kind = 'charge' and i.status = 'open'
      and i.due_date between ${range.from}::date and ${range.to}::date
    group by 1, 2`.execute(db);
  const collected = await sql<{ source: RevenueLine["source"]; type_id: string | null; amount: number }>`
    select ${SOURCE} as source, ${TYPE} as type_id, sum(a.amount)::bigint as amount
    from effective_allocations a
    join payments pay on pay.id = a.payment_id
    join installments i on i.id = a.installment_id ${OWNERS}
    where i.centre_id = ${centreId} and i.member_id is not null
      and (pay.received_at at time zone ${timezone})::date between ${range.from}::date and ${range.to}::date
    group by 1, 2`.execute(db);
  const names = new Map(
    (await db.selectFrom("cw_resource_types").select(["id", "name"]).where("centre_id", "=", centreId).execute()).map((t) => [t.id, t.name]),
  );
  const lines = new Map<string, RevenueLine>();
  const line = (source: RevenueLine["source"], typeId: string | null) => {
    const key = `${source}:${typeId ?? ""}`;
    let found = lines.get(key);
    if (!found) {
      found = { source, typeId, typeName: typeId ? (names.get(typeId) ?? null) : null, issued: 0, collected: 0 };
      lines.set(key, found);
    }
    return found;
  };
  for (const row of issued.rows) line(row.source, row.type_id).issued += row.amount;
  for (const row of collected.rows) line(row.source, row.type_id).collected += row.amount;
  const order = { bookings: 0, packs: 1, subscriptions: 2 };
  return [...lines.values()].sort((a, b) => order[a.source] - order[b.source] || (a.typeName ?? "").localeCompare(b.typeName ?? ""));
}

export interface BookingIndicators {
  /** Bookings that held their resource in the period (confirmed, checked in, completed, no-show). */
  bookings: number;
  noShows: number;
  /** No-shows among the bookings that reached their start (checked in, completed, no-show), in basis points. */
  noShowRate: number;
  lateCancellations: number;
  /** Cancellations later than free_cancel_hours before the start, among held and cancelled bookings, in basis points. */
  lateCancellationRate: number;
  averageMinutes: number;
  /** Average time between the request and the start. */
  averageLeadMinutes: number;
  activeSubscriptions: number;
  /** Monthly recurring revenue of the subscriptions active on the last day: price divided by the months of the plan period. */
  monthlyRecurringRevenue: number;
  /** Guests turned into portal members in the period. */
  convertedGuests: number;
}

/** Headline indicators of the coworking for a period. */
export async function bookingIndicators(db: Db, centreId: string, range: StatsRange): Promise<BookingIndicators> {
  const { timezone } = await centreCalendar(db, centreId);
  const settings = await coworkingSettings(db, centreId);
  const localDay = sql<string>`(starts_at at time zone ${timezone})::date`;
  const counts = await db
    .selectFrom("cw_bookings")
    .select([
      sql<number>`count(*) filter (where status in ('confirmed', 'checked_in', 'completed', 'no_show'))::integer`.as("held"),
      sql<number>`count(*) filter (where status in ('checked_in', 'completed', 'no_show'))::integer`.as("started"),
      sql<number>`count(*) filter (where status = 'no_show')::integer`.as("noShows"),
      sql<number>`count(*) filter (where status = 'cancelled')::integer`.as("cancelled"),
      sql<number>`count(*) filter (where status = 'cancelled' and cancelled_at > starts_at - make_interval(hours => ${settings.free_cancel_hours}))::integer`.as(
        "late",
      ),
      sql<number>`coalesce(round(avg(extract(epoch from ends_at - starts_at) / 60) filter (where status in ('confirmed', 'checked_in', 'completed', 'no_show'))), 0)::integer`.as(
        "averageMinutes",
      ),
      sql<number>`coalesce(round(avg(extract(epoch from starts_at - requested_at) / 60) filter (where status in ('confirmed', 'checked_in', 'completed', 'no_show'))), 0)::integer`.as(
        "averageLeadMinutes",
      ),
    ])
    .where("centre_id", "=", centreId)
    .where("kind", "=", "booking")
    .where(localDay, ">=", range.from)
    .where(localDay, "<=", range.to)
    .executeTakeFirstOrThrow();
  const subscriptions = await db
    .selectFrom("cw_subscriptions")
    .innerJoin("cw_plans", "cw_plans.id", "cw_subscriptions.plan_id")
    .select(["cw_subscriptions.price", "cw_plans.period"])
    .where("cw_subscriptions.centre_id", "=", centreId)
    .where("cw_subscriptions.status", "=", "active")
    .where("cw_subscriptions.starts_on", "<=", range.to)
    .where("cw_subscriptions.ends_on", ">=", range.to)
    .execute();
  const conversions = await db
    .selectFrom("audit_log")
    .select(sql<number>`count(*)::integer`.as("count"))
    .where("centre_id", "=", centreId)
    .where("action", "=", "member.converted")
    .where(sql<string>`(at at time zone ${timezone})::date`, ">=", range.from)
    .where(sql<string>`(at at time zone ${timezone})::date`, "<=", range.to)
    .executeTakeFirstOrThrow();
  return {
    bookings: counts.held,
    noShows: counts.noShows,
    noShowRate: rate(counts.noShows, counts.started),
    lateCancellations: counts.late,
    lateCancellationRate: rate(counts.late, counts.held + counts.cancelled),
    averageMinutes: counts.averageMinutes,
    averageLeadMinutes: counts.averageLeadMinutes,
    activeSubscriptions: subscriptions.length,
    monthlyRecurringRevenue: subscriptions.reduce((sum, s) => sum + mulDivRound(s.price, 1, MONTHS_OF_PERIOD[s.period]), 0),
    convertedGuests: conversions.count,
  };
}

export interface TopMember {
  memberId: string;
  name: string;
  company: string | null;
  collected: number;
}

/** Members who paid the most for coworking in the period (effective allocations by payment date). */
export async function topMembers(db: Db, centreId: string, range: StatsRange, limit = 10): Promise<TopMember[]> {
  const { timezone } = await centreCalendar(db, centreId);
  const rows = await db
    .selectFrom("effective_allocations as a")
    .innerJoin("payments as pay", "pay.id", "a.payment_id")
    .innerJoin("installments as i", "i.id", "a.installment_id")
    .innerJoin("members as m", "m.id", "i.member_id")
    .leftJoin("companies as c", "c.id", "m.company_id")
    .select([
      "m.id as memberId",
      sql<string>`m.first_name || coalesce(' ' || m.last_name, '')`.as("name"),
      "c.name as company",
      sql<number>`sum(a.amount)::bigint`.as("collected"),
    ])
    .where("i.centre_id", "=", centreId)
    .where(sql<string>`(pay.received_at at time zone ${timezone})::date`, ">=", range.from)
    .where(sql<string>`(pay.received_at at time zone ${timezone})::date`, "<=", range.to)
    .groupBy(["m.id", "m.first_name", "m.last_name", "c.name"])
    .orderBy(sql`sum(a.amount)`, "desc")
    .orderBy("m.id")
    .limit(limit)
    .execute();
  return rows;
}
