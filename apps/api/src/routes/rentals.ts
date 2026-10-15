import type { FastifyPluginAsync } from "fastify";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { Database, RentalUnit } from "../db/types.js";
import { recordFinancialEvents } from "../domain/financialEvents.js";
import { centreClock, installmentBalances, lockPayer, payerTotals, settlePayer } from "../domain/ledger.js";
import { renderRentalQuote } from "../domain/rentalQuotePdf.js";
import { expandPattern, priceRental, rentalSchedule, type SlotInstant } from "../domain/rentals.js";
import { findRoomConflicts, toInstants, type SessionConflict } from "../domain/sessions.js";
import { conflict, HttpError, notFound, unprocessable } from "../errors.js";
import { clockTime, idParam, isoDate, millimes, optionalEmail, optionalText, reason, requiredText, uuid } from "../validation.js";

const UNITS = ["hour", "half_day", "day", "month", "year"] as const;
const UNIT_FR: Record<RentalUnit, string> = { hour: "heure", half_day: "demi-journée", day: "journée", month: "mois", year: "année" };

const renterFields = { name: requiredText(150), company: optionalText(150), phone: optionalText(40), email: optionalEmail };
const renterCreate = z.object(renterFields).strict();
const renterUpdate = z.object(renterFields).partial().strict();
const ratesBody = z.object({ rates: z.array(z.object({ unit: z.enum(UNITS), amount: millimes }).strict()).max(5) }).strict();

const slotList = z.array(z.object({ date: isoDate, startTime: clockTime, endTime: clockTime }).strict().refine((s) => s.endTime > s.startTime, "the end time must be after the start time")).min(1).max(400);
const pattern = z
  .object({ from: isoDate, to: isoDate, weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7), startTime: clockTime, endTime: clockTime })
  .strict()
  .refine((p) => p.endTime > p.startTime, "the end time must be after the start time");
const rentalBody = z
  .object({
    renterId: uuid,
    roomId: uuid,
    unit: z.enum(UNITS),
    periods: z.number().int().min(1).max(120).optional(),
    slots: slotList.optional(),
    pattern: pattern.optional(),
    paymentMode: z.enum(["full", "deposit_balance", "recurring"]),
    deposit: millimes.optional(),
    notes: optionalText(1000),
  })
  .strict()
  .refine((r) => !!r.slots !== !!r.pattern, "give either explicit slots or a weekly pattern");
const cancelBody = z.object({ reason }).strict();
const listQuery = z.object({ roomId: uuid.optional(), renterId: uuid.optional(), status: z.enum(["active", "cancelled", "all"]).default("active") });
const planningQuery = z.object({ from: isoDate, to: isoDate });

interface Evaluated {
  room: { id: string; name: string };
  slots: SlotInstant[];
  pricing: ReturnType<typeof priceRental>;
  lines: ReturnType<typeof rentalSchedule>;
  conflicts: SessionConflict[];
}

async function evaluate(trx: Transaction<Database>, centreId: string, body: z.infer<typeof rentalBody>): Promise<Evaluated> {
  const room = await trx.selectFrom("rooms").select(["id", "name", "status"]).where("id", "=", body.roomId).where("centre_id", "=", centreId).executeTakeFirst();
  if (!room || room.status !== "active") throw unprocessable("unknown_room", "the room does not exist or is archived");
  const renter = await trx.selectFrom("renters").select("id").where("id", "=", body.renterId).where("centre_id", "=", centreId).executeTakeFirst();
  if (!renter) throw notFound("renter");
  const clock = await centreClock(trx, centreId);
  const local = body.slots ?? expandPattern(body.pattern!);
  if (local.length === 0) throw unprocessable("no_slot", "the pattern produces no slot");
  const candidates = local.map((s) => ({ ...s, roomId: room.id }));
  const slots = await toInstants(trx, clock.timezone, candidates);
  const sorted = [...slots].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.startsAt < sorted[i - 1]!.endsAt) throw unprocessable("overlapping_slots", "two slots of the rental overlap");
  }
  const rates = new Map((await trx.selectFrom("room_rates").select(["unit", "amount"]).where("room_id", "=", room.id).execute()).map((r) => [r.unit, r.amount]));
  const pricing = priceRental(rates, body.unit, slots, body.periods);
  const firstDay = [...local].map((s) => s.date).sort()[0]!;
  const lines = rentalSchedule(pricing, body.unit, body.paymentMode, clock.today, firstDay, room.name, body.deposit);
  const conflicts: SessionConflict[] = [];
  for (const slot of slots) conflicts.push(...(await findRoomConflicts(trx, room.id, slot.startsAt, slot.endsAt)));
  return { room: { id: room.id, name: room.name }, slots, pricing, lines, conflicts };
}

export const rentalRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const read = app.requirePermission("catalogue:read");
  const write = app.requirePermission("rooms:write");

  /* Renters: simple records, no account. */

  app.get("/renters", { preHandler: read }, async (request) =>
    db.selectFrom("renters").select(["id", "name", "company", "phone", "email"]).where("centre_id", "=", request.user!.centreId).orderBy("name").execute(),
  );

  app.post("/renters", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const body = renterCreate.parse(request.body);
    const row = await db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto("renters")
        .values({ centre_id: actor.centreId, name: body.name, company: body.company ?? null, phone: body.phone ?? null, email: body.email ?? null })
        .returning(["id", "name", "company", "phone", "email"])
        .executeTakeFirstOrThrow();
      await writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action: "renter.created", objectType: "renter", objectId: created.id, after: created });
      return created;
    });
    return reply.status(201).send(row);
  });

  app.patch("/renters/:id", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = renterUpdate.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom("renters").select(["id", "name", "company", "phone", "email"]).where("id", "=", id).where("centre_id", "=", actor.centreId).forUpdate().executeTakeFirst();
      if (!before) throw notFound("renter");
      const after = await trx
        .updateTable("renters")
        .set({
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.company === undefined ? {} : { company: body.company }),
          ...(body.phone === undefined ? {} : { phone: body.phone }),
          ...(body.email === undefined ? {} : { email: body.email }),
        })
        .where("id", "=", id)
        .returning(["id", "name", "company", "phone", "email"])
        .executeTakeFirstOrThrow();
      await writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action: "renter.updated", objectType: "renter", objectId: id, before, after });
      return after;
    });
  });

  /* Room tariff grid */

  app.get("/rooms/:id/rates", { preHandler: read }, async (request) => {
    const { id } = idParam.parse(request.params);
    const room = await db.selectFrom("rooms").select("id").where("id", "=", id).where("centre_id", "=", request.user!.centreId).executeTakeFirst();
    if (!room) throw notFound("room");
    return db.selectFrom("room_rates").select(["unit", "amount"]).where("room_id", "=", id).execute();
  });

  app.put("/rooms/:id/rates", { preHandler: app.requirePermission("catalogue:write") }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = ratesBody.parse(request.body);
    if (new Set(body.rates.map((r) => r.unit)).size !== body.rates.length) throw unprocessable("duplicate_unit", "each unit appears once");
    return db.transaction().execute(async (trx) => {
      const room = await trx.selectFrom("rooms").select("id").where("id", "=", id).where("centre_id", "=", actor.centreId).forUpdate().executeTakeFirst();
      if (!room) throw notFound("room");
      const before = await trx.selectFrom("room_rates").select(["unit", "amount"]).where("room_id", "=", id).execute();
      await trx.deleteFrom("room_rates").where("room_id", "=", id).execute();
      if (body.rates.length) await trx.insertInto("room_rates").values(body.rates.map((r) => ({ room_id: id, unit: r.unit, amount: r.amount }))).execute();
      await writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action: "room.rates_updated", objectType: "room", objectId: id, before, after: body.rates });
      return body.rates;
    });
  });

  /* Rentals */

  /** Price, schedule and real-time conflict check, before anything is saved. */
  app.post("/rentals/preview", { preHandler: write }, async (request) => {
    const body = rentalBody.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const result = await evaluate(trx, request.user!.centreId, body);
      return { pricing: result.pricing, schedule: result.lines, slots: result.slots.length, conflicts: result.conflicts };
    });
  });

  app.post("/rentals", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const body = rentalBody.parse(request.body);
    const created = await db.transaction().execute(async (trx) => {
      await lockPayer(trx, { kind: "renter", id: body.renterId }, actor.centreId);
      const result = await evaluate(trx, actor.centreId, body);
      if (result.conflicts.length) throw new HttpError(409, "schedule_conflict", "the room is not free on every slot", { conflicts: result.conflicts });
      const rental = await trx
        .insertInto("rentals")
        .values({
          centre_id: actor.centreId,
          renter_id: body.renterId,
          room_id: body.roomId,
          unit: body.unit,
          quantity: result.pricing.quantity,
          unit_price: result.pricing.unitPrice,
          total: result.pricing.total,
          payment_mode: body.paymentMode,
          notes: body.notes ?? null,
          created_by: actor.userId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      for (const slot of result.slots) {
        const row = await trx.insertInto("rental_slots").values({ rental_id: rental.id, starts_at: slot.startsAt, ends_at: slot.endsAt }).returning("id").executeTakeFirstOrThrow();
        await trx
          .insertInto("room_bookings")
          .values({ centre_id: actor.centreId, room_id: body.roomId, period: sql<string>`tstzrange(${slot.startsAt}, ${slot.endsAt})` as unknown as string, session_id: null, rental_slot_id: row.id })
          .execute();
      }
      const charges = await trx
        .insertInto("installments")
        .values(result.lines.map((l) => ({ centre_id: actor.centreId, enrolment_id: null, rental_id: rental.id, label: l.label, kind: "charge" as const, amount: l.amount, due_date: l.dueDate, original_due_date: l.dueDate, discount_status: null, created_by: actor.userId })))
        .returning(["id", "amount"])
        .execute();
      await recordFinancialEvents(trx, [
        { centreId: actor.centreId, type: "rental_booked", amount: result.pricing.total, userId: actor.userId, rentalId: rental.id, renterId: body.renterId, roomId: body.roomId, payload: { unit: body.unit, quantity: result.pricing.quantity } },
        ...charges.map((c) => ({ centreId: actor.centreId, type: "installment_issued" as const, amount: c.amount, userId: actor.userId, installmentId: c.id, rentalId: rental.id, renterId: body.renterId, roomId: body.roomId })),
      ]);
      await settlePayer(trx, actor.centreId, { kind: "renter", id: body.renterId }, actor.userId);
      await writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action: "rental.created", objectType: "rental", objectId: rental.id, after: { ...body, pricing: result.pricing, schedule: result.lines } });
      return { id: rental.id, pricing: result.pricing, schedule: result.lines };
    });
    return reply.status(201).send(created);
  });

  app.get("/rentals", { preHandler: read }, async (request) => {
    const query = listQuery.parse(request.query);
    return db
      .selectFrom("rentals")
      .innerJoin("renters", "renters.id", "rentals.renter_id")
      .innerJoin("rooms", "rooms.id", "rentals.room_id")
      .leftJoin(db.selectFrom("rental_slots").select(["rental_id", sql<Date>`min(starts_at)`.as("firstStart"), sql<Date>`max(ends_at)`.as("lastEnd"), sql<number>`count(*)::integer`.as("slots")]).groupBy("rental_id").as("s"), "s.rental_id", "rentals.id")
      .select(["rentals.id", "renters.name as renterName", "rooms.name as roomName", "rentals.unit", "rentals.quantity", "rentals.total", "rentals.payment_mode as paymentMode", "rentals.status", "s.firstStart", "s.lastEnd", "s.slots"])
      .where("rentals.centre_id", "=", request.user!.centreId)
      .$if(query.status !== "all", (qb) => qb.where("rentals.status", "=", query.status as "active" | "cancelled"))
      .$if(query.roomId !== undefined, (qb) => qb.where("rentals.room_id", "=", query.roomId!))
      .$if(query.renterId !== undefined, (qb) => qb.where("rentals.renter_id", "=", query.renterId!))
      .orderBy("s.firstStart", "desc")
      .execute();
  });

  app.get("/rentals/:id", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const { id } = idParam.parse(request.params);
    const rental = await db
      .selectFrom("rentals")
      .innerJoin("renters", "renters.id", "rentals.renter_id")
      .innerJoin("rooms", "rooms.id", "rentals.room_id")
      .select(["rentals.id", "rentals.renter_id as renterId", "renters.name as renterName", "renters.company", "rentals.room_id as roomId", "rooms.name as roomName", "rentals.unit", "rentals.quantity", "rentals.unit_price as unitPrice", "rentals.total", "rentals.payment_mode as paymentMode", "rentals.status", "rentals.cancel_reason as cancelReason", "rentals.notes"])
      .where("rentals.id", "=", id)
      .where("rentals.centre_id", "=", centreId)
      .executeTakeFirst();
    if (!rental) throw notFound("rental");
    const slots = await db.selectFrom("rental_slots").select(["id", "starts_at as startsAt", "ends_at as endsAt"]).where("rental_id", "=", id).orderBy("starts_at").execute();
    const schedule = await installmentBalances(db, centreId, { rentalId: id });
    const receipts = await db
      .selectFrom("receipts")
      .innerJoin("payments", "payments.id", "receipts.payment_id")
      .innerJoin("allocations", "allocations.payment_id", "payments.id")
      .innerJoin("installments", "installments.id", "allocations.installment_id")
      .select(["receipts.id", "receipts.number", "receipts.issued_at as issuedAt"])
      .where("installments.rental_id", "=", id)
      .distinct()
      .execute();
    const totals = await payerTotals(db, centreId, { kind: "renter", id: rental.renterId });
    return { ...rental, slots, schedule, receipts, renterTotals: totals };
  });

  /** Frees the future slots and cancels unpaid instalments; money already received stays as the renter's credit. */
  app.post("/rentals/:id/cancel", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = cancelBody.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const rental = await trx.selectFrom("rentals").select(["id", "status", "renter_id", "room_id"]).where("id", "=", id).where("centre_id", "=", actor.centreId).forUpdate().executeTakeFirst();
      if (!rental) throw notFound("rental");
      if (rental.status === "cancelled") throw conflict("already_cancelled", "the rental is already cancelled");
      await lockPayer(trx, { kind: "renter", id: rental.renter_id }, actor.centreId);
      await trx.updateTable("rentals").set({ status: "cancelled", cancelled_at: new Date(), cancel_reason: body.reason }).where("id", "=", id).execute();
      await sql`update room_bookings set active = false where rental_slot_id in (select id from rental_slots where rental_id = ${id} and starts_at > now())`.execute(trx);
      const open = (await installmentBalances(trx, actor.centreId, { rentalId: id })).filter((i) => i.status === "open" && i.kind === "charge" && i.paid === 0);
      for (const i of open) {
        await trx.updateTable("installments").set({ status: "cancelled", cancelled_at: new Date(), cancelled_by: actor.userId, cancel_reason: `location annulée : ${body.reason}` }).where("id", "=", i.id).execute();
      }
      await recordFinancialEvents(trx, open.map((i) => ({ centreId: actor.centreId, type: "installment_cancelled" as const, amount: -i.amount, userId: actor.userId, installmentId: i.id, rentalId: id, renterId: rental.renter_id, roomId: rental.room_id })));
      await writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action: "rental.cancelled", objectType: "rental", objectId: id, reason: body.reason, after: { cancelledInstallments: open.length } });
      return { id, status: "cancelled", cancelledInstallments: open.length };
    });
  });

  app.get("/rentals/:id/contract.pdf", { preHandler: read }, async (request, reply) => {
    const centreId = request.user!.centreId;
    const { id } = idParam.parse(request.params);
    const rental = await db
      .selectFrom("rentals")
      .innerJoin("renters", "renters.id", "rentals.renter_id")
      .innerJoin("rooms", "rooms.id", "rentals.room_id")
      .innerJoin("centres", "centres.id", "rentals.centre_id")
      .select(["rentals.id", "rentals.unit", "rentals.quantity", "rentals.unit_price as unitPrice", "rentals.total", "renters.name", "renters.company", "renters.phone", "renters.email", "rooms.name as roomName", "centres.name as centreName", "centres.address", "centres.timezone", sql<string>`to_char(now() at time zone centres.timezone, 'DD/MM/YYYY')`.as("today")])
      .where("rentals.id", "=", id)
      .where("rentals.centre_id", "=", centreId)
      .executeTakeFirst();
    if (!rental) throw notFound("rental");
    const slots = await db
      .selectFrom("rental_slots")
      .select(sql<string>`to_char(starts_at at time zone ${rental.timezone}, 'DD/MM/YYYY HH24:MI') || ' - ' || to_char(ends_at at time zone ${rental.timezone}, 'HH24:MI')`.as("label"))
      .where("rental_id", "=", id)
      .orderBy("starts_at")
      .execute();
    const schedule = await installmentBalances(db, centreId, { rentalId: id });
    const quantityLabel = rental.unit === "hour" ? `${(rental.quantity / 60).toString().replace(".", ",")} heure(s)` : `${rental.quantity} ${UNIT_FR[rental.unit]}(s)`;
    const pdf = await renderRentalQuote({
      centreName: rental.centreName,
      centreAddress: rental.address,
      reference: `LOC-${rental.id.slice(0, 8).toUpperCase()}`,
      renter: { name: rental.name, company: rental.company, phone: rental.phone, email: rental.email },
      roomName: rental.roomName,
      unitLabel: UNIT_FR[rental.unit],
      quantityLabel,
      unitPrice: rental.unitPrice,
      total: rental.total,
      slots: slots.map((s) => s.label),
      schedule: schedule.filter((s) => s.status === "open").map((s) => ({ label: s.label, dueDate: s.dueDate, amount: s.amount })),
      issuedAt: rental.today,
    });
    return reply.header("content-type", "application/pdf").header("content-disposition", `inline; filename="location-${rental.id.slice(0, 8)}.pdf"`).send(pdf);
  });

  /* Unified planning: class sessions and rental slots, for a view by room, instructor or group on the client. */

  app.get("/planning", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const query = planningQuery.parse(request.query);
    if (query.to < query.from) throw unprocessable("invalid_range", "the end date cannot be before the start date");
    const { timezone } = await centreClock(db, centreId);
    const localDay = (column: string) => sql<string>`(${sql.ref(column)} at time zone ${timezone})::date`;
    const sessions = await db
      .selectFrom("class_sessions")
      .innerJoin("groups", "groups.id", "class_sessions.group_id")
      .innerJoin("instructors", "instructors.id", "class_sessions.instructor_id")
      .leftJoin("rooms", "rooms.id", "class_sessions.room_id")
      .select([
        "class_sessions.id",
        "class_sessions.starts_at as startsAt",
        "class_sessions.ends_at as endsAt",
        "class_sessions.status",
        "class_sessions.sheet_status as sheetStatus",
        "groups.id as groupId",
        "groups.name as groupName",
        "groups.kind as groupKind",
        "instructors.id as instructorId",
        sql<string>`instructors.first_name || ' ' || instructors.last_name`.as("instructorName"),
        "rooms.id as roomId",
        "rooms.name as roomName",
      ])
      .where("class_sessions.centre_id", "=", centreId)
      .where("class_sessions.status", "!=", "cancelled")
      .where(localDay("class_sessions.starts_at"), ">=", query.from)
      .where(localDay("class_sessions.starts_at"), "<=", query.to)
      .orderBy("class_sessions.starts_at")
      .execute();
    const rentals = await db
      .selectFrom("rental_slots")
      .innerJoin("rentals", "rentals.id", "rental_slots.rental_id")
      .innerJoin("renters", "renters.id", "rentals.renter_id")
      .innerJoin("rooms", "rooms.id", "rentals.room_id")
      .select(["rental_slots.id", "rental_slots.starts_at as startsAt", "rental_slots.ends_at as endsAt", "rentals.id as rentalId", "renters.name as renterName", "rooms.id as roomId", "rooms.name as roomName"])
      .where("rentals.centre_id", "=", centreId)
      .where("rentals.status", "=", "active")
      .where(localDay("rental_slots.starts_at"), ">=", query.from)
      .where(localDay("rental_slots.starts_at"), "<=", query.to)
      .orderBy("rental_slots.starts_at")
      .execute();
    return {
      items: [
        ...sessions.map((s) => ({ type: s.groupKind === "training" ? ("training" as const) : ("course" as const), ...s })),
        ...rentals.map((r) => ({ type: "rental" as const, ...r })),
      ].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()),
    };
  });
};
