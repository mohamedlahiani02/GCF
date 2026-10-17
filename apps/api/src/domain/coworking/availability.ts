import { ASSIGNED_CATEGORIES, OCCUPYING_STATUSES, parseLayout, type FloorLayout, type PlanState } from "@gcf/shared";
import { sql } from "kysely";
import type { CwCategory, CwResourceStatus } from "../../db/types.coworking.js";
import { notFound } from "../../errors.js";
import type { Db, InstantSlot } from "./schedule.js";

const occupying = [...OCCUPYING_STATUSES];

/**
 * Number of resources of a type free on each slot: active resources without an occupying booking over the slot
 * plus the type's cleaning buffer, and, for a resource shared with a training room, without any other use of the
 * room over that time.
 */
export async function freeCounts(db: Db, centreId: string, typeId: string, bufferMinutes: number, slots: InstantSlot[]): Promise<number[]> {
  if (slots.length === 0) return [];
  const result = await sql<{ free: number }>`
    select (
      select count(*)::integer from cw_resources r
      where r.centre_id = ${centreId} and r.type_id = ${typeId} and r.status = 'active'
        and not exists (
          select 1 from cw_bookings b
          where b.resource_id = r.id and b.status = any(${occupying}::text[])
            and tstzrange(b.starts_at, b.blocked_until) && tstzrange(s.st, s.en + make_interval(mins => ${bufferMinutes})))
        and (r.room_id is null or not exists (
          select 1 from room_bookings rb
          where rb.room_id = r.room_id and rb.active and rb.period && tstzrange(s.st, s.en + make_interval(mins => ${bufferMinutes}))))
    ) as free
    from unnest(${slots.map((s) => s.startsAt)}::timestamptz[], ${slots.map((s) => s.endsAt)}::timestamptz[]) with ordinality as s(st, en, ord)
    order by s.ord`.execute(db);
  return result.rows.map((r) => r.free);
}

export interface FreeResource {
  id: string;
  code: string;
  name: string | null;
  floorId: string;
  floorName: string;
}

/** Active resources of a type free over [startsAt, blockedUntil), other than `excludeResourceId`. */
export async function freeResources(
  db: Db,
  centreId: string,
  typeId: string,
  startsAt: Date,
  blockedUntil: Date,
  excludeResourceId: string | null,
): Promise<FreeResource[]> {
  const range = sql`tstzrange(${startsAt}, ${blockedUntil})`;
  return db
    .selectFrom("cw_resources as r")
    .innerJoin("cw_floors as f", "f.id", "r.floor_id")
    .select(["r.id", "r.code", "r.name", "r.floor_id as floorId", "f.name as floorName"])
    .where("r.centre_id", "=", centreId)
    .where("r.type_id", "=", typeId)
    .where("r.status", "=", "active")
    .$if(excludeResourceId !== null, (qb) => qb.where("r.id", "!=", excludeResourceId!))
    .where(
      sql<boolean>`not exists (select 1 from cw_bookings b where b.resource_id = r.id and b.status = any(${occupying}::text[])
        and tstzrange(b.starts_at, b.blocked_until) && ${range})`,
    )
    .where(
      sql<boolean>`(r.room_id is null or not exists (select 1 from room_bookings rb where rb.room_id = r.room_id and rb.active and rb.period && ${range}))`,
    )
    .orderBy("f.position")
    .orderBy("r.code")
    .execute();
}

/** Who occupies a resource, for the staff only. */
export interface OccupantSummary {
  bookingId: string;
  kind: "booking" | "block";
  status: string;
  startsAt: Date;
  endsAt: Date;
  memberId: string | null;
  memberName: string | null;
  phone: string | null;
  company: string | null;
  charge: number;
  paid: number;
  notes: string | null;
}

export interface ResourceState {
  resourceId: string;
  code: string;
  name: string | null;
  typeId: string;
  typeName: string;
  category: CwCategory;
  capacity: number;
  zoneId: string | null;
  status: CwResourceStatus;
  state: PlanState;
  /** Staff view only: the booking or block behind the state. */
  occupant?: OccupantSummary;
  /** Staff view only: the subscriber of an assigned resource. */
  subscriber?: { memberId: string; memberName: string; company: string | null; endsOn: string };
}

export interface FloorState {
  floor: { id: string; name: string; layout: FloorLayout };
  resources: ResourceState[];
}

/** When the plan is looked at: one instant, or a slot of a local date (each resource adds its type's buffer). */
export type PlanWindow = { at: Date; date: string } | { startsAt: Date; endsAt: Date; date: string };

const RANK: Record<string, number> = { checked_in: 3, confirmed: 2, requested: 1 };

/**
 * State of every resource of a floor at an instant or over a slot (rule 15), in this order: assigned (an assigned
 * category with an active subscription that day), blocked (out of service or an occupying block), occupied
 * (checked in), booked (confirmed), requested, free. The staff view names the occupant; the portal view carries
 * no personal data.
 */
export async function floorState(db: Db, centreId: string, floorId: string, window: PlanWindow, audience: "staff" | "portal"): Promise<FloorState> {
  const floor = await db
    .selectFrom("cw_floors")
    .select(["id", "name", "layout"])
    .where("id", "=", floorId)
    .where("centre_id", "=", centreId)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!floor) throw notFound("floor");
  const resources = await db
    .selectFrom("cw_resources as r")
    .innerJoin("cw_resource_types as t", "t.id", "r.type_id")
    .select([
      "r.id",
      "r.code",
      "r.name",
      "r.type_id as typeId",
      "t.name as typeName",
      "t.category",
      "t.buffer_minutes as bufferMinutes",
      "r.capacity",
      "r.zone_id as zoneId",
      "r.status",
    ])
    .where("r.floor_id", "=", floorId)
    .where("r.centre_id", "=", centreId)
    .where("r.status", "!=", "archived")
    .orderBy("r.code")
    .execute();
  const ids = resources.map((r) => r.id);
  const from = "at" in window ? window.at : window.startsAt;
  const until = "at" in window ? window.at : window.endsAt;
  const maxBuffer = Math.max(0, ...resources.map((r) => r.bufferMinutes));
  const bounds = "at" in window ? "[]" : "[)";
  const bookings = ids.length
    ? await db
        .selectFrom("cw_bookings as b")
        .leftJoin("members as m", "m.id", "b.member_id")
        .leftJoin("companies as c", "c.id", "m.company_id")
        .select([
          "b.id",
          "b.resource_id as resourceId",
          "b.kind",
          "b.status",
          sql<Date>`b.starts_at`.as("startsAt"),
          sql<Date>`b.ends_at`.as("endsAt"),
          sql<Date>`b.blocked_until`.as("blockedUntil"),
          "b.member_id as memberId",
          sql<string | null>`case when m.id is null then null else m.first_name || coalesce(' ' || m.last_name, '') end`.as("memberName"),
          "m.phone",
          "c.name as company",
          "b.charge",
          "b.notes",
          sql<number>`(select coalesce(sum(a.amount), 0)::bigint from effective_allocations a join installments i on i.id = a.installment_id where i.cw_booking_id = b.id)`.as(
            "paid",
          ),
        ])
        .where("b.resource_id", "in", ids)
        .where("b.status", "in", occupying)
        .where(sql<boolean>`tstzrange(b.starts_at, b.blocked_until) && tstzrange(${from}, ${new Date(until.getTime() + maxBuffer * 60_000)}, ${bounds})`)
        .execute()
    : [];
  const subscriptions = ids.length
    ? await db
        .selectFrom("cw_subscriptions as s")
        .innerJoin("members as m", "m.id", "s.member_id")
        .leftJoin("companies as c", "c.id", "m.company_id")
        .select([
          "s.assigned_resource_id as resourceId",
          "s.member_id as memberId",
          sql<string>`m.first_name || coalesce(' ' || m.last_name, '')`.as("memberName"),
          "c.name as company",
          "s.ends_on as endsOn",
        ])
        .where("s.assigned_resource_id", "in", ids)
        .where("s.status", "=", "active")
        .where("s.starts_on", "<=", window.date)
        .where("s.ends_on", ">=", window.date)
        .execute()
    : [];

  const states = resources.map((r): ResourceState => {
    const base: ResourceState = {
      resourceId: r.id,
      code: r.code,
      name: r.name,
      typeId: r.typeId,
      typeName: r.typeName,
      category: r.category,
      capacity: r.capacity,
      zoneId: r.zoneId,
      status: r.status,
      state: "free",
    };
    const subscription = ASSIGNED_CATEGORIES.includes(r.category) ? subscriptions.find((s) => s.resourceId === r.id) : undefined;
    if (subscription) {
      return {
        ...base,
        state: "assigned",
        ...(audience === "staff"
          ? { subscriber: { memberId: subscription.memberId, memberName: subscription.memberName, company: subscription.company, endsOn: subscription.endsOn } }
          : {}),
      };
    }
    const reach = new Date(until.getTime() + r.bufferMinutes * 60_000);
    const overlapping = bookings.filter(
      (b) => b.resourceId === r.id && ("at" in window ? b.startsAt <= window.at && window.at < b.blockedUntil : b.startsAt < reach && from < b.blockedUntil),
    );
    const block = overlapping.find((b) => b.kind === "block");
    const booking = overlapping.filter((b) => b.kind === "booking").sort((a, b) => (RANK[b.status] ?? 0) - (RANK[a.status] ?? 0))[0];
    const shown = block ?? booking;
    let state: PlanState = "free";
    if (r.status === "out_of_service" || block) state = "blocked";
    else if (booking) state = booking.status === "checked_in" ? "occupied" : booking.status === "confirmed" ? "booked" : "requested";
    if (audience === "portal" || !shown) return { ...base, state };
    return {
      ...base,
      state,
      occupant: {
        bookingId: shown.id,
        kind: shown.kind,
        status: shown.status,
        startsAt: shown.startsAt,
        endsAt: shown.endsAt,
        memberId: shown.memberId,
        memberName: shown.memberName,
        phone: shown.phone,
        company: shown.company,
        charge: shown.charge,
        paid: Number(shown.paid),
        notes: shown.kind === "block" ? shown.notes : null,
      },
    };
  });
  return { floor: { id: floor.id, name: floor.name, layout: parseLayout(floor.layout) }, resources: states };
}
