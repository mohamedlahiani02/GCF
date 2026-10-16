import { addDays, CW_BOOKING_STATUSES } from "@gcf/shared";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { freeCounts, freeResources, floorState } from "../../domain/coworking/availability.js";
import {
  approveBooking,
  cancelBooking,
  checkIn,
  createBlock,
  createBooking,
  loadBooking,
  quoteBooking,
  reassignBooking,
  refuseBooking,
  releaseBooking,
  removeBlock,
  type MailContext,
} from "../../domain/coworking/bookings.js";
import { centreCalendar, coworkingSettings, formatSlots, localInstants, openingOn } from "../../domain/coworking/schedule.js";
import { bookingIndicators, occupancyByResource, occupancyHeatmap, revenueByType, topMembers } from "../../domain/coworking/stats.js";
import { installmentBalances } from "../../domain/ledger.js";
import { notFound, unprocessable } from "../../errors.js";
import { clockTime, idParam, isoDate, optionalText, reason, requiredText, uuid } from "../../validation.js";

const slotsQuery = z.object({
  date: isoDate,
  durationMinutes: z.coerce.number().int().min(15).max(1440).optional(),
});
const stateQuery = z
  .object({ at: z.string().datetime({ offset: true }).optional(), date: isoDate.optional(), startTime: clockTime.optional(), endTime: clockTime.optional() })
  .refine((q) => (q.at !== undefined) !== (q.date !== undefined && q.startTime !== undefined && q.endTime !== undefined), "give either an instant or a slot")
  .refine((q) => q.startTime === undefined || q.endTime === undefined || q.endTime > q.startTime, "the end time must be after the start time");
const dayQuery = z.object({ date: isoDate });
const listQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  status: z.enum([...CW_BOOKING_STATUSES, "all"]).default("all"),
  kind: z.enum(["booking", "block"]).default("booking"),
  memberId: uuid.optional(),
  resourceId: uuid.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const bookingBody = z
  .object({
    memberId: uuid,
    resourceId: uuid,
    formatId: uuid,
    date: isoDate,
    startTime: clockTime,
    durationMinutes: z.number().int().min(15).max(1440).optional(),
    promoCode: optionalText(30),
    notes: optionalText(1000),
    override: z.boolean().default(false),
  })
  .strict();
const reasonBody = z.object({ reason }).strict();
const reassignBody = z.object({ resourceId: uuid }).strict();
const codeBody = z.object({ code: requiredText(64) }).strict();
const blockBody = z
  .object({ resourceId: uuid, startDate: isoDate, startTime: clockTime, endDate: isoDate, endTime: clockTime, reason })
  .strict()
  .refine((b) => `${b.endDate} ${b.endTime}` > `${b.startDate} ${b.startTime}`, "the end must be after the start");
const rangeQuery = z.object({ from: isoDate, to: isoDate });

/** Statistics cover at most one year so a request stays cheap. */
function statsRange(request: FastifyRequest) {
  const range = rangeQuery.parse(request.query);
  if (range.to < range.from) throw unprocessable("invalid_range", "the end date cannot be before the start date");
  if (range.to > addDays(range.from, 366)) throw unprocessable("period_too_long", "statistics cover at most one year");
  return range;
}

/** Bookings, blocks, check-in, availability, the live plan, planning, requests and statistics (staff). */
export const coworkingBookingRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const read = app.requirePermission("coworking:read");
  const write = app.requirePermission("coworking:write");
  const reports = app.requirePermission("coworking:reports");
  const mail = (request: FastifyRequest): MailContext => ({ mailer: app.mailer, log: request.log, publicOrigin: app.config.publicOrigin });

  /* Availability and the live plan */

  /** Start slots of a format on a date, with the number of free resources of its type on each. */
  app.get("/formats/:id/slots", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const { id } = idParam.parse(request.params);
    const query = slotsQuery.parse(request.query);
    const format = await db
      .selectFrom("cw_booking_formats as f")
      .innerJoin("cw_resource_types as t", "t.id", "f.type_id")
      .selectAll("f")
      .select("t.buffer_minutes as bufferMinutes")
      .where("f.id", "=", id)
      .where("f.centre_id", "=", centreId)
      .where("f.status", "=", "active")
      .executeTakeFirst();
    if (!format) throw notFound("format");
    const day = await openingOn(db, centreId, query.date);
    const slots = formatSlots(format, day.open, query.date, query.durationMinutes);
    const { timezone } = await centreCalendar(db, centreId);
    const instants = await localInstants(
      db,
      timezone,
      slots.map((s) => ({ date: query.date, startTime: s.startTime, endTime: s.endTime })),
    );
    const free = await freeCounts(db, centreId, format.type_id, format.bufferMinutes, instants);
    return {
      date: query.date,
      open: day.open,
      closures: day.closures,
      slots: slots.map((s, i) => ({ ...s, startsAt: instants[i]!.startsAt, endsAt: instants[i]!.endsAt, free: free[i]! })),
    };
  });

  /** State of every resource of a floor at an instant (?at=) or for a local slot (?date=&startTime=&endTime=). */
  app.get("/floors/:id/state", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const { id } = idParam.parse(request.params);
    const query = stateQuery.parse(request.query);
    const { timezone } = await centreCalendar(db, centreId);
    if (query.at !== undefined) {
      const at = new Date(query.at);
      const local = await sql<{ date: string }>`select to_char(${at}::timestamptz at time zone ${timezone}, 'YYYY-MM-DD') as date`.execute(db);
      return floorState(db, centreId, id, { at, date: local.rows[0]!.date }, "staff");
    }
    const [slot] = await localInstants(db, timezone, [{ date: query.date!, startTime: query.startTime!, endTime: query.endTime! }]);
    return floorState(db, centreId, id, { startsAt: slot!.startsAt, endsAt: slot!.endsAt, date: query.date! }, "staff");
  });

  /** One local day for a timeline: the opening, then each floor with its resources and their bookings and blocks. */
  app.get("/planning", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const { date } = dayQuery.parse(request.query);
    const { timezone } = await centreCalendar(db, centreId);
    const day = await openingOn(db, centreId, date);
    const floors = await db
      .selectFrom("cw_floors")
      .select(["id", "name"])
      .where("centre_id", "=", centreId)
      .where("status", "=", "active")
      .orderBy("position")
      .orderBy("name")
      .execute();
    const resources = await db
      .selectFrom("cw_resources as r")
      .innerJoin("cw_resource_types as t", "t.id", "r.type_id")
      .select(["r.id", "r.floor_id as floorId", "r.code", "r.name", "r.status", "t.id as typeId", "t.name as typeName", "t.category"])
      .where("r.centre_id", "=", centreId)
      .where("r.status", "!=", "archived")
      .orderBy("t.position")
      .orderBy("r.code")
      .execute();
    const localDay = (column: string) => sql<string>`(${sql.ref(column)} at time zone ${timezone})::date`;
    const bookings = await db
      .selectFrom("cw_bookings as b")
      .leftJoin("members as m", "m.id", "b.member_id")
      .leftJoin("companies as c", "c.id", "m.company_id")
      .select([
        "b.id",
        "b.kind",
        "b.resource_id as resourceId",
        "b.status",
        sql<Date>`b.starts_at`.as("startsAt"),
        sql<Date>`b.ends_at`.as("endsAt"),
        sql<Date>`b.blocked_until`.as("blockedUntil"),
        "b.member_id as memberId",
        sql<string | null>`case when m.id is null then null else m.first_name || coalesce(' ' || m.last_name, '') end`.as("memberName"),
        "c.name as company",
        "b.charge",
        "b.notes",
      ])
      .where("b.centre_id", "=", centreId)
      .where("b.status", "in", ["requested", "confirmed", "checked_in", "completed", "no_show"])
      .where(localDay("b.starts_at"), "<=", date)
      .where(localDay("b.ends_at"), ">=", date)
      .orderBy("b.starts_at")
      .execute();
    return {
      date,
      open: day.open,
      closures: day.closures,
      floors: floors.map((f) => ({
        ...f,
        resources: resources
          .filter((r) => r.floorId === f.id)
          .map(({ floorId: _floorId, ...r }) => ({ ...r, bookings: bookings.filter((b) => b.resourceId === r.id) })),
      })),
    };
  });

  /* Bookings */

  /** Requests waiting for a decision, the oldest start first, with the moment each one expires. */
  app.get("/requests", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const settings = await coworkingSettings(db, centreId);
    const rows = await db
      .selectFrom("cw_bookings as b")
      .innerJoin("cw_resources as r", "r.id", "b.resource_id")
      .innerJoin("cw_resource_types as t", "t.id", "r.type_id")
      .innerJoin("members as m", "m.id", "b.member_id")
      .leftJoin("companies as c", "c.id", "m.company_id")
      .select([
        "b.id",
        sql<Date>`b.starts_at`.as("startsAt"),
        sql<Date>`b.ends_at`.as("endsAt"),
        "b.requested_at as requestedAt",
        sql<Date>`least(b.starts_at, b.requested_at + make_interval(hours => ${settings.request_expiry_hours}))`.as("expiresAt"),
        "b.profile",
        "b.charge",
        "b.notes",
        "r.id as resourceId",
        "r.code as resourceCode",
        "t.name as typeName",
        "m.id as memberId",
        sql<string>`m.first_name || coalesce(' ' || m.last_name, '')`.as("memberName"),
        "m.phone",
        "m.email",
        "c.name as company",
      ])
      .where("b.centre_id", "=", centreId)
      .where("b.status", "=", "requested")
      .orderBy("b.starts_at")
      .execute();
    return { items: rows };
  });

  app.get("/bookings", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const query = listQuery.parse(request.query);
    if (query.from && query.to && query.to < query.from) throw unprocessable("invalid_range", "the end date cannot be before the start date");
    const { timezone } = await centreCalendar(db, centreId);
    const localDay = sql<string>`(b.starts_at at time zone ${timezone})::date`;
    const rows = await db
      .selectFrom("cw_bookings as b")
      .innerJoin("cw_resources as r", "r.id", "b.resource_id")
      .innerJoin("cw_resource_types as t", "t.id", "r.type_id")
      .leftJoin("cw_booking_formats as f", "f.id", "b.format_id")
      .leftJoin("members as m", "m.id", "b.member_id")
      .leftJoin("companies as c", "c.id", "m.company_id")
      .select([
        "b.id",
        "b.kind",
        "b.status",
        "b.source",
        sql<Date>`b.starts_at`.as("startsAt"),
        sql<Date>`b.ends_at`.as("endsAt"),
        "r.id as resourceId",
        "r.code as resourceCode",
        "t.name as typeName",
        "f.label as formatLabel",
        "m.id as memberId",
        sql<string | null>`case when m.id is null then null else m.first_name || coalesce(' ' || m.last_name, '') end`.as("memberName"),
        "c.name as company",
        "b.profile",
        "b.list_price as listPrice",
        "b.charge",
        "b.late_cancel_fee as lateCancelFee",
        "b.notes",
      ])
      .where("b.centre_id", "=", centreId)
      .where("b.kind", "=", query.kind)
      .$if(query.status !== "all", (qb) => qb.where("b.status", "=", query.status as (typeof CW_BOOKING_STATUSES)[number]))
      .$if(query.from !== undefined, (qb) => qb.where(localDay, ">=", query.from!))
      .$if(query.to !== undefined, (qb) => qb.where(localDay, "<=", query.to!))
      .$if(query.memberId !== undefined, (qb) => qb.where("b.member_id", "=", query.memberId!))
      .$if(query.resourceId !== undefined, (qb) => qb.where("b.resource_id", "=", query.resourceId!))
      .orderBy("b.starts_at", "desc")
      .limit(query.pageSize + 1)
      .offset((query.page - 1) * query.pageSize)
      .execute();
    return { items: rows.slice(0, query.pageSize), hasMore: rows.length > query.pageSize, page: query.page };
  });

  /** A booking with its charges and their payment state, what it took from quotas and packs, and its access events. */
  app.get("/bookings/:id", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const { id } = idParam.parse(request.params);
    const booking = await loadBooking(db, centreId, id);
    const chargeIds = (await db.selectFrom("installments").select("id").where("cw_booking_id", "=", id).execute()).map((c) => c.id);
    const charges = chargeIds.length ? await installmentBalances(db, centreId, { installmentIds: chargeIds }) : [];
    const usage = await db
      .selectFrom("cw_entitlement_usage as u")
      .leftJoin("cw_subscriptions as s", "s.id", "u.subscription_id")
      .leftJoin("cw_plans as pl", "pl.id", "s.plan_id")
      .leftJoin("cw_packs as p", "p.id", "u.pack_id")
      .leftJoin("cw_pack_products as pp", "pp.id", "p.product_id")
      .select([
        "u.id",
        "u.subscription_id as subscriptionId",
        "u.pack_id as packId",
        sql<string>`coalesce(pl.name, pp.name)`.as("label"),
        "u.quota_kind as quotaKind",
        "u.amount",
        "u.window_start as windowStart",
        "u.status",
      ])
      .where("u.booking_id", "=", id)
      .orderBy("u.created_at")
      .execute();
    const accessEvents = await db
      .selectFrom("cw_access_events as e")
      .leftJoin("users", "users.id", "e.recorded_by")
      .select(["e.id", "e.at", "e.source", "users.full_name as recordedBy"])
      .where("e.booking_id", "=", id)
      .orderBy("e.at")
      .execute();
    return {
      ...booking,
      charges,
      paid: charges.reduce((s, c) => s + c.paid, 0),
      due: charges.reduce((s, c) => s + c.remaining, 0),
      usage,
      accessEvents,
    };
  });

  /** Free resources of the same type to move a booking to. */
  app.get("/bookings/:id/alternatives", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const { id } = idParam.parse(request.params);
    const booking = await loadBooking(db, centreId, id);
    return { items: await freeResources(db, centreId, booking.typeId, booking.startsAt, booking.blockedUntil, booking.resourceId) };
  });

  app.post("/bookings/quote", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const body = bookingBody.parse(request.body);
    return quoteBooking(db, actor.centreId, { source: "staff", userId: actor.userId }, body);
  });

  app.post("/bookings", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const body = bookingBody.parse(request.body);
    const created = await createBooking(db, actor.centreId, { source: "staff", userId: actor.userId }, body);
    return reply.status(201).send({ ...created.booking, quote: created.quote, overridden: created.overridden });
  });

  app.post("/bookings/:id/approve", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    return approveBooking(db, mail(request), actor.centreId, actor.userId, id);
  });

  app.post("/bookings/:id/refuse", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = reasonBody.parse(request.body);
    return refuseBooking(db, mail(request), actor.centreId, actor.userId, id, body.reason);
  });

  app.post("/bookings/:id/cancel", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = reasonBody.parse(request.body);
    const result = await cancelBooking(db, mail(request), actor.centreId, { source: "staff", userId: actor.userId }, id, body.reason);
    return { ...result.booking, free: result.free, fee: result.fee };
  });

  app.post("/bookings/:id/reassign", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = reassignBody.parse(request.body);
    return reassignBooking(db, actor.centreId, actor.userId, id, body.resourceId);
  });

  app.post("/bookings/:id/check-in", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    return checkIn(db, actor.centreId, { bookingId: id }, { source: "staff", userId: actor.userId });
  });

  /** Check-in by the code of the booking's QR, scanned at the desk. */
  app.post("/check-in", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const body = codeBody.parse(request.body);
    return checkIn(db, actor.centreId, { code: body.code }, { source: "qr", userId: actor.userId });
  });

  app.post("/bookings/:id/release", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    return releaseBooking(db, actor.centreId, actor.userId, id);
  });

  /* Blocks */

  app.post("/blocks", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const body = blockBody.parse(request.body);
    return reply.status(201).send(await createBlock(db, actor.centreId, actor.userId, body));
  });

  app.delete("/blocks/:id", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    await removeBlock(db, actor.centreId, actor.userId, id);
    return reply.status(204).send();
  });

  /* Statistics */

  app.get("/stats/occupancy", { preHandler: reports }, async (request) => occupancyByResource(db, request.user!.centreId, statsRange(request)));
  app.get("/stats/heatmap", { preHandler: reports }, async (request) => ({ types: await occupancyHeatmap(db, request.user!.centreId, statsRange(request)) }));
  app.get("/stats/revenue", { preHandler: reports }, async (request) => ({ lines: await revenueByType(db, request.user!.centreId, statsRange(request)) }));
  app.get("/stats/indicators", { preHandler: reports }, async (request) => bookingIndicators(db, request.user!.centreId, statsRange(request)));
  app.get("/stats/top-members", { preHandler: reports }, async (request) => ({ items: await topMembers(db, request.user!.centreId, statsRange(request)) }));
};
