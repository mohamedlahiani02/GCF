import { addDays, CW_CATEGORY_LABELS, isBookableCategory, OCCUPYING_STATUSES, SITE_LANGUAGES, todayIn } from "@gcf/shared";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { sql, type Kysely } from "kysely";
import QRCode from "qrcode";
import { z } from "zod";
import type { Database } from "../../db/types.js";
import { floorState, freeCounts } from "../../domain/coworking/availability.js";
import { cancelBooking, cancellationTerms, createBooking, quoteBooking, type BookingActor, type MailContext } from "../../domain/coworking/bookings.js";
import { activeSubscriptions, profileOf } from "../../domain/coworking/entitlements.js";
import { listPrice } from "../../domain/coworking/pricing.js";
import { centreCalendar, formatSlots, localInstants, openingOn, type CoworkingSettings } from "../../domain/coworking/schedule.js";
import { installmentBalances } from "../../domain/ledger.js";
import { conflict, HttpError, notFound, unprocessable } from "../../errors.js";
import { clockTime, idParam, isoDate, optionalText, reason, toClock, uuid } from "../../validation.js";
import { calendarFile } from "./calendar.js";
import { signedIn } from "./context.js";

const occupying = [...OCCUPYING_STATUSES];

const slotsQuery = z.object({ date: isoDate, durationMinutes: z.coerce.number().int().min(15).max(1440).optional() });
const stateQuery = z
  .object({ date: isoDate, startTime: clockTime, endTime: clockTime })
  .refine((q) => q.endTime > q.startTime, "the end time must be after the start time");
const bookingBody = z
  .object({
    resourceId: uuid,
    formatId: uuid,
    date: isoDate,
    startTime: clockTime,
    durationMinutes: z.number().int().min(15).max(1440).optional(),
    promoCode: optionalText(30),
    notes: optionalText(1000),
  })
  .strict();
const listQuery = z.object({
  scope: z.enum(["upcoming", "past"]).default("upcoming"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
const reasonBody = z.object({ reason }).strict();
const calendarQuery = z.object({ lang: z.enum(SITE_LANGUAGES).default("fr") });

/** Bookings of the centre as the portal shows them to their owner: no notes (they may be the staff's), no other client. */
function bookingRows(db: Kysely<Database>, centreId: string, timezone: string) {
  return db
    .selectFrom("cw_bookings as b")
    .innerJoin("cw_resources as r", "r.id", "b.resource_id")
    .innerJoin("cw_resource_types as t", "t.id", "r.type_id")
    .innerJoin("cw_floors as fl", "fl.id", "r.floor_id")
    .leftJoin("cw_booking_formats as f", "f.id", "b.format_id")
    .select([
      "b.id",
      "b.member_id as memberId",
      "b.status",
      "r.id as resourceId",
      "r.code as resourceCode",
      "r.name as resourceName",
      "t.id as typeId",
      "t.name as typeName",
      "t.category",
      "fl.id as floorId",
      "fl.name as floorName",
      "f.label as formatLabel",
      sql<string>`to_char(b.starts_at at time zone ${timezone}, 'YYYY-MM-DD')`.as("date"),
      sql<string>`to_char(b.starts_at at time zone ${timezone}, 'HH24:MI')`.as("startTime"),
      sql<string>`to_char(b.ends_at at time zone ${timezone}, 'HH24:MI')`.as("endTime"),
      sql<Date>`b.starts_at`.as("startsAt"),
      sql<Date>`b.ends_at`.as("endsAt"),
      "b.profile",
      "b.list_price as listPrice",
      "b.covered_minutes as coveredMinutes",
      "b.coverage_discount as coverageDiscount",
      "b.promo_discount as promoDiscount",
      "b.charge",
      "b.late_cancel_fee as lateCancelFee",
      "b.requested_at as requestedAt",
      "b.refusal_reason as refusalReason",
      "b.cancelled_at as cancelledAt",
      "b.cancel_reason as cancelReason",
      "b.checked_in_at as checkedInAt",
      sql<number>`(select coalesce(sum(a.amount), 0)::bigint from effective_allocations a join installments i on i.id = a.installment_id
        where i.cw_booking_id = b.id)`.as("paid"),
      sql<number>`(select coalesce(sum(a.amount), 0)::bigint from effective_allocations a join installments i on i.id = a.installment_id
        where i.cw_booking_id = b.id and i.kind = 'charge' and i.status = 'open')`.as("paidOnOpenCharges"),
      sql<number>`(select coalesce(sum(i.amount - coalesce((select sum(a.amount) from effective_allocations a where a.installment_id = i.id), 0)), 0)::bigint
        from installments i where i.cw_booking_id = b.id and i.kind = 'charge' and i.status = 'open')`.as("due"),
    ])
    .where("b.centre_id", "=", centreId)
    .where("b.kind", "=", "booking");
}

type BookingRow = Awaited<ReturnType<ReturnType<typeof bookingRows>["execute"]>>[number];

/**
 * The portal view of a booking. Whether it can be cancelled and what a cancellation now would cost follow rule 11
 * through cancellationTerms, like cancelBooking: requests and confirmed bookings without money received on their charge.
 */
function presentBooking(row: BookingRow, settings: CoworkingSettings, now: Date) {
  const { memberId: _memberId, paidOnOpenCharges, ...booking } = row;
  const cancellable = (row.status === "requested" || row.status === "confirmed") && paidOnOpenCharges === 0;
  return {
    ...booking,
    cancellable,
    cancellation: cancellable ? cancellationTerms(row, settings, now) : null,
    qrAvailable: row.status === "confirmed" && row.endsAt > now,
  };
}

/** Catalogue, availability, the floor plan and the member's own bookings (portal). */
export const portalBookingRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app;
  const mail = (request: FastifyRequest): MailContext => ({ mailer: app.mailer, log: request.log, publicOrigin: config.publicOrigin });
  const actorOf = (memberId: string): BookingActor => ({ source: "portal", memberId });

  /** The member's booking, or 404 for a booking of anyone else. */
  const ownBooking = async (centreId: string, memberId: string, id: string) => {
    const { timezone } = await centreCalendar(db, centreId);
    const row = await bookingRows(db, centreId, timezone).where("b.id", "=", id).where("b.member_id", "=", memberId).executeTakeFirst();
    if (!row) throw notFound("booking");
    return row;
  };

  /**
   * Bookable types open to the public, with the price of each format for the member's profile today (the hourly
   * rate for a free format), the capacity range of their resources and the floors holding them. Formats without
   * a price are not for sale and types without an active resource or a format for sale are left out.
   */
  app.get("/catalogue", async (request) => {
    const { centre, settings, member } = await signedIn(db, request);
    const { timezone } = await centreCalendar(db, centre.id);
    const today = todayIn(timezone);
    const profile = profileOf(member.kind, await activeSubscriptions(db, member.memberId, today));
    const types = (
      await db
        .selectFrom("cw_resource_types")
        .select([
          "id",
          "name",
          "category",
          "description",
          "photo_media_id as photoMediaId",
          "requires_approval as requiresApproval",
          "max_minutes_per_day as maxMinutesPerDay",
        ])
        .where("centre_id", "=", centre.id)
        .where("status", "=", "active")
        .where("public", "=", true)
        .orderBy("position")
        .orderBy("name")
        .execute()
    ).filter((t) => isBookableCategory(t.category));
    const typeIds = types.map((t) => t.id);
    const resources = typeIds.length
      ? await db
          .selectFrom("cw_resources as r")
          .innerJoin("cw_floors as fl", "fl.id", "r.floor_id")
          .select(["r.type_id as typeId", "r.capacity", "fl.id as floorId", "fl.name as floorName"])
          .where("r.centre_id", "=", centre.id)
          .where("r.status", "=", "active")
          .where("fl.status", "=", "active")
          .where("r.type_id", "in", typeIds)
          .orderBy("fl.position")
          .orderBy("fl.name")
          .execute()
      : [];
    const formats = typeIds.length
      ? await db
          .selectFrom("cw_booking_formats")
          .selectAll()
          .where("centre_id", "=", centre.id)
          .where("status", "=", "active")
          .where("type_id", "in", typeIds)
          .orderBy("position")
          .orderBy("label")
          .execute()
      : [];
    const priceAt = (format: (typeof formats)[number], startTime: string, offpeakFrom: string | null) =>
      listPrice(db, format, profile, startTime, 60, offpeakFrom).catch((error: unknown) => {
        if (error instanceof HttpError && error.code === "no_price") return null;
        throw error;
      });
    const offers = await Promise.all(
      formats.map(async (format) => {
        const base = await priceAt(format, "00:00", null);
        if (!base) return null;
        const offpeak = settings.offpeak_from ? await priceAt(format, settings.offpeak_from, settings.offpeak_from) : null;
        return {
          typeId: format.type_id,
          id: format.id,
          label: format.label,
          nature: format.nature,
          durationMinutes: format.duration_minutes,
          startStepMinutes: format.start_step_minutes,
          startTime: format.start_time === null ? null : toClock(format.start_time),
          endTime: format.end_time === null ? null : toClock(format.end_time),
          minMinutes: format.min_minutes,
          maxMinutes: format.max_minutes,
          weekdays: format.weekdays,
          price: {
            amount: base.rate,
            offpeakAmount: offpeak?.offpeak ? offpeak.rate : null,
            perHour: format.nature === "free",
            profile: base.priceProfile,
          },
        };
      }),
    );
    const priced = offers.filter((offer) => offer !== null);
    const items = types.flatMap((t) => {
      const own = resources.filter((r) => r.typeId === t.id);
      const offered = priced.filter((f) => f.typeId === t.id).map(({ typeId: _typeId, ...f }) => f);
      if (own.length === 0 || offered.length === 0) return [];
      const floors = own.filter((r, i) => own.findIndex((o) => o.floorId === r.floorId) === i).map((r) => ({ id: r.floorId, name: r.floorName }));
      const capacities = own.map((r) => r.capacity);
      return [
        {
          ...t,
          photoUrl: t.photoMediaId ? `/media/${t.photoMediaId}` : null,
          capacity: { min: Math.min(...capacities), max: Math.max(...capacities) },
          floors,
          formats: offered,
        },
      ];
    });
    return {
      date: today,
      profile,
      offpeakFrom: settings.offpeak_from,
      rules: {
        approvalMode: settings.approval_mode,
        bookingHorizonDays: settings.booking_horizon_days,
        horizonEnd: addDays(today, settings.booking_horizon_days),
        minNoticeMinutes: settings.min_notice_minutes,
        maxActiveBookings: settings.max_active_bookings,
        freeCancelHours: settings.free_cancel_hours,
        lateCancelFeeBp: settings.late_cancel_fee_bp,
      },
      types: items,
    };
  });

  /**
   * Start slots of a format on a date with the number of free resources on each. Slots the portal cannot book
   * any more (past, or inside the minimum notice) are left out; a date beyond the booking horizon is refused.
   */
  app.get("/formats/:id/slots", async (request) => {
    const { centre, settings } = await signedIn(db, request);
    const { id } = idParam.parse(request.params);
    const query = slotsQuery.parse(request.query);
    const format = await db
      .selectFrom("cw_booking_formats as f")
      .innerJoin("cw_resource_types as t", "t.id", "f.type_id")
      .selectAll("f")
      .select(["t.buffer_minutes as bufferMinutes", "t.category"])
      .where("f.id", "=", id)
      .where("f.centre_id", "=", centre.id)
      .where("f.status", "=", "active")
      .where("t.status", "=", "active")
      .where("t.public", "=", true)
      .executeTakeFirst();
    if (!format || !isBookableCategory(format.category)) throw notFound("format");
    const { timezone } = await centreCalendar(db, centre.id);
    const now = new Date();
    const horizonEnd = addDays(todayIn(timezone, now), settings.booking_horizon_days);
    if (query.date > horizonEnd) throw unprocessable("beyond_horizon", `bookings open ${settings.booking_horizon_days} days ahead`);
    const day = await openingOn(db, centre.id, query.date);
    const slots = formatSlots(format, day.open, query.date, query.durationMinutes);
    const instants = await localInstants(
      db,
      timezone,
      slots.map((s) => ({ date: query.date, startTime: s.startTime, endTime: s.endTime })),
    );
    const free = await freeCounts(db, centre.id, format.type_id, format.bufferMinutes, instants);
    const earliest = now.getTime() + settings.min_notice_minutes * 60_000;
    return {
      date: query.date,
      open: day.open,
      closures: day.closures,
      horizonEnd,
      slots: slots
        .map((s, i) => ({ ...s, startsAt: instants[i]!.startsAt, endsAt: instants[i]!.endsAt, free: free[i]! }))
        .filter((s) => s.startsAt.getTime() >= earliest),
    };
  });

  /** State of every resource of a floor over a local slot, without any personal data. */
  app.get("/floors/:id/state", async (request) => {
    const { centre } = await signedIn(db, request);
    const { id } = idParam.parse(request.params);
    const query = stateQuery.parse(request.query);
    const { timezone } = await centreCalendar(db, centre.id);
    const [slot] = await localInstants(db, timezone, [{ date: query.date, startTime: query.startTime, endTime: query.endTime }]);
    const state = await floorState(db, centre.id, id, { startsAt: slot!.startsAt, endsAt: slot!.endsAt, date: query.date }, "portal");
    const floor = await db.selectFrom("cw_floors").select("plan_media_id").where("id", "=", id).executeTakeFirstOrThrow();
    return { ...state, floor: { ...state.floor, planMediaId: floor.plan_media_id } };
  });

  /** Price and status a booking would get; the member is always the signed-in one and portal limits are errors. */
  app.post("/bookings/quote", async (request) => {
    const { centre, member } = await signedIn(db, request);
    const body = bookingBody.parse(request.body);
    return quoteBooking(db, centre.id, actorOf(member.memberId), { ...body, memberId: member.memberId });
  });

  app.post("/bookings", async (request, reply) => {
    const { centre, settings, member } = await signedIn(db, request);
    const body = bookingBody.parse(request.body);
    const created = await createBooking(db, centre.id, actorOf(member.memberId), { ...body, memberId: member.memberId });
    const row = await ownBooking(centre.id, member.memberId, created.booking.id);
    return reply.status(201).send(presentBooking(row, settings, new Date()));
  });

  app.get("/bookings", async (request) => {
    const { centre, settings, member } = await signedIn(db, request);
    const query = listQuery.parse(request.query);
    const { timezone } = await centreCalendar(db, centre.id);
    const now = new Date();
    const upcoming = sql<boolean>`b.status = any(${occupying}::text[]) and b.ends_at > ${now}`;
    const rows = await bookingRows(db, centre.id, timezone)
      .where("b.member_id", "=", member.memberId)
      .where(query.scope === "upcoming" ? upcoming : sql<boolean>`not (${upcoming})`)
      .orderBy("b.starts_at", query.scope === "upcoming" ? "asc" : "desc")
      .orderBy("b.id")
      .limit(query.pageSize + 1)
      .offset((query.page - 1) * query.pageSize)
      .execute();
    return { items: rows.slice(0, query.pageSize).map((r) => presentBooking(r, settings, now)), hasMore: rows.length > query.pageSize, page: query.page };
  });

  /** One booking of the member with its charges and their payment state. */
  app.get("/bookings/:id", async (request) => {
    const { centre, settings, member } = await signedIn(db, request);
    const { id } = idParam.parse(request.params);
    const row = await ownBooking(centre.id, member.memberId, id);
    const chargeIds = (await db.selectFrom("installments").select("id").where("cw_booking_id", "=", id).execute()).map((c) => c.id);
    const charges = chargeIds.length ? await installmentBalances(db, centre.id, { installmentIds: chargeIds }) : [];
    return {
      ...presentBooking(row, settings, new Date()),
      charges: charges.map((c) => ({ id: c.id, label: c.label, amount: c.amount, dueDate: c.dueDate, paid: c.paid, remaining: c.remaining, state: c.state })),
    };
  });

  app.post("/bookings/:id/cancel", async (request) => {
    const { centre, settings, member } = await signedIn(db, request);
    const { id } = idParam.parse(request.params);
    const body = reasonBody.parse(request.body);
    await ownBooking(centre.id, member.memberId, id);
    const result = await cancelBooking(db, mail(request), centre.id, actorOf(member.memberId), id, body.reason);
    const row = await ownBooking(centre.id, member.memberId, id);
    return { ...presentBooking(row, settings, new Date()), free: result.free, fee: result.fee };
  });

  /** QR code of the check-in code, shown at the desk; only a confirmed booking that has not ended has one. */
  app.get("/bookings/:id/qr.svg", async (request, reply) => {
    const { centre, member } = await signedIn(db, request);
    const { id } = idParam.parse(request.params);
    const row = await ownBooking(centre.id, member.memberId, id);
    if (row.status !== "confirmed") throw conflict("not_confirmed", "only a confirmed booking has a check-in code");
    if (row.endsAt <= new Date()) throw conflict("already_ended", "the booking is over");
    const { check_in_code: code } = await db.selectFrom("cw_bookings").select("check_in_code").where("id", "=", id).executeTakeFirstOrThrow();
    const svg = await QRCode.toString(code, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
    return reply.header("content-type", "image/svg+xml; charset=utf-8").header("cache-control", "private, no-store").send(svg);
  });

  /** The booking as an iCalendar event, in UTC, located at the centre's address. */
  app.get("/bookings/:id/calendar.ics", async (request, reply) => {
    const { centre, member } = await signedIn(db, request);
    const { id } = idParam.parse(request.params);
    const { lang } = calendarQuery.parse(request.query);
    const row = await ownBooking(centre.id, member.memberId, id);
    const place = await db.selectFrom("centres").select(["name", "address"]).where("id", "=", centre.id).executeTakeFirstOrThrow();
    const status = row.status === "requested" ? "TENTATIVE" : occupying.includes(row.status) || row.status === "completed" ? "CONFIRMED" : "CANCELLED";
    const ics = calendarFile(
      {
        uid: `cw-booking-${row.id}`,
        stamp: new Date(),
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        summary: `${CW_CATEGORY_LABELS[lang][row.category]} ${row.resourceCode}, ${place.name}`,
        location: place.address,
        status,
      },
      `-//GCF//Coworking//${lang.toUpperCase()}`,
    );
    return reply
      .header("content-type", "text/calendar; charset=utf-8")
      .header("content-disposition", `attachment; filename="reservation-${row.resourceCode.replace(/[^A-Za-z0-9-]/g, "_")}-${row.date}.ics"`)
      .header("cache-control", "private, no-store")
      .send(ics);
  });
};
