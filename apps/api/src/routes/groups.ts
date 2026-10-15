import type { FastifyPluginAsync } from "fastify";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { Database } from "../db/types.js";
import { monthBounds } from "../domain/payrollCalc.js";
import { findSlotConflicts, type WeeklySlot } from "../domain/slotConflicts.js";
import { conflict, HttpError, notFound, unprocessable } from "../errors.js";
import { archiveBody, clockTime, idParam, isoDate, millimes, requiredText, toClock, uuid, yearMonth } from "../validation.js";

const slot = z
  .object({ weekday: z.number().int().min(1).max(7), startTime: clockTime, endTime: clockTime, roomId: uuid.nullable().optional() })
  .strict()
  .refine((s) => s.endTime > s.startTime, "the end time must be after the start time");

const createBody = z
  .object({
    kind: z.enum(["study", "training"]),
    studyId: uuid.optional(),
    trainingSessionId: uuid.optional(),
    name: requiredText(100),
    instructorId: uuid,
    roomId: uuid.nullable().optional(),
    capacity: z.number().int().min(1).max(1000).optional(),
    startDate: isoDate,
    endDate: isoDate,
    priceOverride: millimes.nullable().optional(),
    absenceBilledOverride: z.boolean().nullable().optional(),
    countJustifiedOverride: z.boolean().nullable().optional(),
    countMakeupOverride: z.boolean().nullable().optional(),
    slots: z.array(slot).max(14),
  })
  .strict()
  .refine((g) => g.endDate >= g.startDate, "the end date cannot be before the start date")
  .refine(
    (g) => (g.kind === "study" ? !!g.studyId && !g.trainingSessionId : !!g.trainingSessionId && !g.studyId),
    "a study group needs studyId, a training group needs trainingSessionId",
  );

const updateBody = z
  .object({
    name: requiredText(100),
    instructorId: uuid,
    roomId: uuid.nullable(),
    capacity: z.number().int().min(1).max(1000),
    startDate: isoDate,
    endDate: isoDate,
    priceOverride: millimes.nullable(),
    absenceBilledOverride: z.boolean().nullable(),
    countJustifiedOverride: z.boolean().nullable(),
    countMakeupOverride: z.boolean().nullable(),
  })
  .partial()
  .strict();

const slotsBody = z.object({ slots: z.array(slot).max(14) }).strict();
const checkBody = z
  .object({
    instructorId: uuid,
    roomId: uuid.nullable().optional(),
    startDate: isoDate,
    endDate: isoDate,
    slots: z.array(slot).max(14),
    groupId: uuid.optional(),
  })
  .strict();
const listQuery = z.object({ studyId: uuid.optional(), trainingSessionId: uuid.optional(), status: z.enum(["active", "archived", "all"]).default("active") });

function toSlots(slots: z.infer<typeof slot>[]): WeeklySlot[] {
  return slots.map((s) => ({ weekday: s.weekday, startTime: s.startTime, endTime: s.endTime, roomId: s.roomId ?? null }));
}

async function assertRefs(trx: Transaction<Database>, centreId: string, refs: { instructorId?: string; roomIds: (string | null | undefined)[] }) {
  if (refs.instructorId) {
    const instructor = await trx
      .selectFrom("instructors")
      .select("status")
      .where("id", "=", refs.instructorId)
      .where("centre_id", "=", centreId)
      .executeTakeFirst();
    if (!instructor || instructor.status !== "active") throw unprocessable("unknown_instructor", "the instructor does not exist or is archived");
  }
  const roomIds = [...new Set(refs.roomIds.filter((r): r is string => !!r))];
  if (roomIds.length) {
    const rooms = await trx
      .selectFrom("rooms")
      .select("id")
      .where("centre_id", "=", centreId)
      .where("status", "=", "active")
      .where("id", "in", roomIds)
      .execute();
    if (rooms.length !== roomIds.length) throw unprocessable("unknown_room", "one of the rooms does not exist or is archived");
  }
}

const scheduleConflict = (details: unknown) => new HttpError(409, "schedule_conflict", "the schedule conflicts with another group", details);

export const groupRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const read = app.requirePermission("catalogue:read");
  const write = app.requirePermission("groups:write");

  const detail = async (id: string, centreId: string) => {
    const group = await db
      .selectFrom("groups")
      .innerJoin("instructors", "instructors.id", "groups.instructor_id")
      .leftJoin("rooms", "rooms.id", "groups.room_id")
      .leftJoin("studies", "studies.id", "groups.study_id")
      .leftJoin("training_sessions", "training_sessions.id", "groups.training_session_id")
      .leftJoin("trainings", "trainings.id", "training_sessions.training_id")
      .innerJoin("centres", "centres.id", "groups.centre_id")
      .select([
        "groups.id",
        "groups.kind",
        "groups.name",
        "groups.study_id as studyId",
        "studies.name as studyName",
        "groups.training_session_id as trainingSessionId",
        "trainings.id as trainingId",
        "trainings.title as trainingTitle",
        "training_sessions.name as trainingSessionName",
        "groups.instructor_id as instructorId",
        "instructors.first_name as instructorFirstName",
        "instructors.last_name as instructorLastName",
        "groups.room_id as roomId",
        "rooms.name as roomName",
        "groups.capacity",
        "groups.start_date as startDate",
        "groups.end_date as endDate",
        "groups.price_override as priceOverride",
        "groups.absence_billed_override as absenceBilledOverride",
        "groups.count_justified_override as countJustifiedOverride",
        "groups.count_makeup_override as countMakeupOverride",
        "groups.status",
        "studies.price as studyPrice",
        "studies.billing_mode as billingMode",
        "studies.absence_billed as studyAbsenceBilled",
        "trainings.price as trainingPrice",
        "centres.count_justified_as_present as centreCountJustified",
        "centres.count_makeup_as_present as centreCountMakeup",
      ])
      .where("groups.id", "=", id)
      .where("groups.centre_id", "=", centreId)
      .executeTakeFirst();
    if (!group) throw notFound("group");
    const slots = await db
      .selectFrom("group_slots")
      .select(["id", "weekday", "start_time", "end_time", "room_id as roomId"])
      .where("group_id", "=", id)
      .orderBy("weekday")
      .orderBy("start_time")
      .execute();
    const students = await db
      .selectFrom("enrolments")
      .innerJoin("students", "students.id", "enrolments.student_id")
      .select([
        "enrolments.id as enrolmentId",
        "students.id as studentId",
        "students.first_name as firstName",
        "students.last_name as lastName",
        "students.is_minor as isMinor",
        "enrolments.effective_date as effectiveDate",
      ])
      .where("enrolments.group_id", "=", id)
      .where("enrolments.status", "=", "active")
      .orderBy("students.last_name")
      .orderBy("students.first_name")
      .execute();
    const { studyPrice, trainingPrice, studyAbsenceBilled, centreCountJustified, centreCountMakeup, ...rest } = group;
    return {
      ...rest,
      effective: {
        price: group.priceOverride ?? (group.kind === "study" ? studyPrice : trainingPrice),
        absenceBilled: group.kind === "study" ? (group.absenceBilledOverride ?? studyAbsenceBilled) : null,
        countJustifiedAsPresent: group.countJustifiedOverride ?? centreCountJustified,
        countMakeupAsPresent: group.countMakeupOverride ?? centreCountMakeup,
      },
      slots: slots.map((s) => ({ id: s.id, weekday: s.weekday, startTime: toClock(s.start_time), endTime: toClock(s.end_time), roomId: s.roomId })),
      enrolledCount: students.length,
      students,
    };
  };

  /**
   * Groups with what the daily screens need: the offer, the weekly slots, the next session and the oldest session
   * whose attendance is still to be entered (started, not cancelled, sheet not validated, in the last 30 days).
   */
  app.get("/", { preHandler: read }, async (request) => {
    const query = listQuery.parse(request.query);
    const centreId = request.user!.centreId;
    const rows = await db
      .selectFrom("groups")
      .innerJoin("instructors", "instructors.id", "groups.instructor_id")
      .leftJoin("rooms", "rooms.id", "groups.room_id")
      .leftJoin("studies", "studies.id", "groups.study_id")
      .leftJoin("training_sessions", "training_sessions.id", "groups.training_session_id")
      .leftJoin("trainings", "trainings.id", "training_sessions.training_id")
      .select([
        "groups.id",
        "groups.kind",
        "groups.name",
        "groups.study_id as studyId",
        "studies.name as studyName",
        "groups.training_session_id as trainingSessionId",
        "training_sessions.name as trainingSessionName",
        "trainings.id as trainingId",
        "trainings.title as trainingTitle",
        "groups.instructor_id as instructorId",
        "instructors.first_name as instructorFirstName",
        "instructors.last_name as instructorLastName",
        "groups.room_id as roomId",
        "rooms.name as roomName",
        "groups.capacity",
        "groups.start_date as startDate",
        "groups.end_date as endDate",
        "groups.status",
      ])
      .select((eb) => [
        eb
          .selectFrom("enrolments")
          .select(sql<number>`count(*)::integer`.as("n"))
          .whereRef("enrolments.group_id", "=", "groups.id")
          .where("enrolments.status", "=", "active")
          .as("enrolledCount"),
        eb
          .selectFrom("class_sessions")
          .select("class_sessions.id")
          .whereRef("class_sessions.group_id", "=", "groups.id")
          .where("class_sessions.status", "=", "scheduled")
          .where("class_sessions.starts_at", ">=", new Date())
          .orderBy("class_sessions.starts_at")
          .limit(1)
          .as("nextSessionId"),
        eb
          .selectFrom("class_sessions")
          .select("class_sessions.starts_at")
          .whereRef("class_sessions.group_id", "=", "groups.id")
          .where("class_sessions.status", "=", "scheduled")
          .where("class_sessions.starts_at", ">=", new Date())
          .orderBy("class_sessions.starts_at")
          .limit(1)
          .as("nextSessionAt"),
        eb
          .selectFrom("class_sessions")
          .select("class_sessions.id")
          .whereRef("class_sessions.group_id", "=", "groups.id")
          .where("class_sessions.status", "!=", "cancelled")
          .where("class_sessions.sheet_status", "!=", "validated")
          .where("class_sessions.starts_at", "<=", new Date())
          .where("class_sessions.starts_at", ">=", new Date(Date.now() - 30 * 86_400_000))
          .orderBy("class_sessions.starts_at")
          .limit(1)
          .as("attendanceSessionId"),
      ])
      .where("groups.centre_id", "=", centreId)
      .$if(query.status !== "all", (qb) => qb.where("groups.status", "=", query.status as "active" | "archived"))
      .$if(query.studyId !== undefined, (qb) => qb.where("groups.study_id", "=", query.studyId!))
      .$if(query.trainingSessionId !== undefined, (qb) => qb.where("groups.training_session_id", "=", query.trainingSessionId!))
      .orderBy("groups.name")
      .execute();
    const slots = rows.length
      ? await db
          .selectFrom("group_slots")
          .select(["group_id as groupId", "weekday", "start_time", "end_time", "room_id as roomId"])
          .where(
            "group_id",
            "in",
            rows.map((r) => r.id),
          )
          .orderBy("weekday")
          .orderBy("start_time")
          .execute()
      : [];
    return rows.map((r) => ({
      ...r,
      enrolledCount: Number(r.enrolledCount ?? 0),
      slots: slots
        .filter((s) => s.groupId === r.id)
        .map((s) => ({ weekday: s.weekday, startTime: toClock(s.start_time), endTime: toClock(s.end_time), roomId: s.roomId })),
    }));
  });

  app.get("/:id", { preHandler: read }, async (request) => {
    const { id } = idParam.parse(request.params);
    return detail(id, request.user!.centreId);
  });

  /** Lets the creation wizard show conflicts before the group is saved. */
  app.post("/check-slots", { preHandler: read }, async (request) => {
    const body = checkBody.parse(request.body);
    const conflicts = await findSlotConflicts(db, {
      centreId: request.user!.centreId,
      instructorId: body.instructorId,
      defaultRoomId: body.roomId ?? null,
      startDate: body.startDate,
      endDate: body.endDate,
      slots: toSlots(body.slots),
      ...(body.groupId ? { excludeGroupId: body.groupId } : {}),
    });
    return { conflicts };
  });

  app.post("/", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const body = createBody.parse(request.body);
    const id = await db.transaction().execute(async (trx) => {
      let capacity = body.capacity;
      if (body.kind === "study") {
        const study = await trx
          .selectFrom("studies")
          .select(["capacity", "status"])
          .where("id", "=", body.studyId!)
          .where("centre_id", "=", actor.centreId)
          .executeTakeFirst();
        if (!study || study.status !== "active") throw unprocessable("unknown_study", "the study does not exist or is archived");
        capacity ??= study.capacity;
      } else {
        const session = await trx
          .selectFrom("training_sessions")
          .innerJoin("trainings", "trainings.id", "training_sessions.training_id")
          .select(["trainings.capacity", "training_sessions.status"])
          .where("training_sessions.id", "=", body.trainingSessionId!)
          .where("training_sessions.centre_id", "=", actor.centreId)
          .executeTakeFirst();
        if (!session || session.status !== "open") throw unprocessable("unknown_training_session", "the training session does not exist or is closed");
        capacity ??= session.capacity;
      }
      await assertRefs(trx, actor.centreId, { instructorId: body.instructorId, roomIds: [body.roomId, ...body.slots.map((s) => s.roomId)] });
      const slots = toSlots(body.slots);
      const conflicts = await findSlotConflicts(trx, {
        centreId: actor.centreId,
        instructorId: body.instructorId,
        defaultRoomId: body.roomId ?? null,
        startDate: body.startDate,
        endDate: body.endDate,
        slots,
      });
      if (conflicts.length) throw scheduleConflict({ conflicts });
      const group = await trx
        .insertInto("groups")
        .values({
          centre_id: actor.centreId,
          kind: body.kind,
          study_id: body.studyId ?? null,
          training_session_id: body.trainingSessionId ?? null,
          name: body.name,
          instructor_id: body.instructorId,
          room_id: body.roomId ?? null,
          capacity,
          start_date: body.startDate,
          end_date: body.endDate,
          price_override: body.priceOverride ?? null,
          absence_billed_override: body.absenceBilledOverride ?? null,
          count_justified_override: body.countJustifiedOverride ?? null,
          count_makeup_override: body.countMakeupOverride ?? null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      if (slots.length) {
        await trx
          .insertInto("group_slots")
          .values(slots.map((s) => ({ group_id: group.id, weekday: s.weekday, start_time: s.startTime, end_time: s.endTime, room_id: s.roomId })))
          .execute();
      }
      await writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action: "group.created", objectType: "group", objectId: group.id, after: body });
      return group.id;
    });
    return reply.status(201).send(await detail(id, actor.centreId));
  });

  app.patch("/:id", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = updateBody.parse(request.body);
    const before = await detail(id, actor.centreId);
    await db.transaction().execute(async (trx) => {
      await trx.selectFrom("groups").select("id").where("id", "=", id).forUpdate().executeTakeFirstOrThrow();
      await assertRefs(trx, actor.centreId, { ...(body.instructorId ? { instructorId: body.instructorId } : {}), roomIds: [body.roomId] });
      const startDate = body.startDate ?? before.startDate;
      const endDate = body.endDate ?? before.endDate;
      if (endDate < startDate) throw unprocessable("invalid_dates", "the end date cannot be before the start date");
      if (body.capacity !== undefined && body.capacity < before.enrolledCount) {
        throw conflict("capacity_below_enrolment", `${before.enrolledCount} students are already enrolled`);
      }
      const conflicts = await findSlotConflicts(trx, {
        centreId: actor.centreId,
        instructorId: body.instructorId ?? before.instructorId,
        defaultRoomId: body.roomId === undefined ? before.roomId : body.roomId,
        startDate,
        endDate,
        slots: before.slots.map((s) => ({ weekday: s.weekday, startTime: s.startTime, endTime: s.endTime, roomId: s.roomId })),
        excludeGroupId: id,
      });
      if (conflicts.length) throw scheduleConflict({ conflicts });
      await trx
        .updateTable("groups")
        .set({
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.instructorId === undefined ? {} : { instructor_id: body.instructorId }),
          ...(body.roomId === undefined ? {} : { room_id: body.roomId }),
          ...(body.capacity === undefined ? {} : { capacity: body.capacity }),
          start_date: startDate,
          end_date: endDate,
          ...(body.priceOverride === undefined ? {} : { price_override: body.priceOverride }),
          ...(body.absenceBilledOverride === undefined ? {} : { absence_billed_override: body.absenceBilledOverride }),
          ...(body.countJustifiedOverride === undefined ? {} : { count_justified_override: body.countJustifiedOverride }),
          ...(body.countMakeupOverride === undefined ? {} : { count_makeup_override: body.countMakeupOverride }),
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .execute();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "group.updated",
        objectType: "group",
        objectId: id,
        before,
        after: body,
      });
    });
    return detail(id, actor.centreId);
  });

  app.put("/:id/slots", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = slotsBody.parse(request.body);
    const before = await detail(id, actor.centreId);
    const slots = toSlots(body.slots);
    await db.transaction().execute(async (trx) => {
      await trx.selectFrom("groups").select("id").where("id", "=", id).forUpdate().executeTakeFirstOrThrow();
      await assertRefs(trx, actor.centreId, { roomIds: slots.map((s) => s.roomId) });
      const conflicts = await findSlotConflicts(trx, {
        centreId: actor.centreId,
        instructorId: before.instructorId,
        defaultRoomId: before.roomId,
        startDate: before.startDate,
        endDate: before.endDate,
        slots,
        excludeGroupId: id,
      });
      if (conflicts.length) throw scheduleConflict({ conflicts });
      await trx.deleteFrom("group_slots").where("group_id", "=", id).execute();
      if (slots.length) {
        await trx
          .insertInto("group_slots")
          .values(slots.map((s) => ({ group_id: id, weekday: s.weekday, start_time: s.startTime, end_time: s.endTime, room_id: s.roomId })))
          .execute();
      }
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "group.slots_updated",
        objectType: "group",
        objectId: id,
        before: before.slots,
        after: slots,
      });
    });
    return detail(id, actor.centreId);
  });

  /** Money of the group for a month: invoiced (instalments due), collected (payments received), still unpaid. */
  app.get("/:id/finance", { preHandler: app.requirePermission("payments:read") }, async (request) => {
    const centreId = request.user!.centreId;
    const { id } = idParam.parse(request.params);
    const { month } = z.object({ month: yearMonth }).parse(request.query);
    const group = await db.selectFrom("groups").select("id").where("id", "=", id).where("centre_id", "=", centreId).executeTakeFirst();
    if (!group) throw notFound("group");
    const { start, end } = monthBounds(month);
    const centre = await db.selectFrom("centres").select("timezone").where("id", "=", centreId).executeTakeFirstOrThrow();
    const invoiced = await db
      .selectFrom("installments")
      .innerJoin("enrolments", "enrolments.id", "installments.enrolment_id")
      .leftJoin(
        db
          .selectFrom("effective_allocations")
          .select(["installment_id", sql<number>`sum(amount)::bigint`.as("paid")])
          .groupBy("installment_id")
          .as("p"),
        "p.installment_id",
        "installments.id",
      )
      .select([
        sql<number>`coalesce(sum(installments.amount) filter (where installments.kind = 'charge'), 0)::bigint`.as("charges"),
        sql<number>`coalesce(sum(installments.amount) filter (where installments.kind = 'discount' and installments.discount_status = 'approved'), 0)::bigint`.as(
          "discounts",
        ),
        sql<number>`coalesce(sum(installments.amount - coalesce(p.paid, 0)) filter (where installments.kind = 'charge'), 0)::bigint`.as("unpaid"),
        sql<number>`coalesce(sum(installments.amount - coalesce(p.paid, 0)) filter (where installments.kind = 'charge' and installments.postponement_count > 0), 0)::bigint`.as(
          "postponed",
        ),
      ])
      .where("enrolments.group_id", "=", id)
      .where("installments.status", "=", "open")
      .where("installments.due_date", ">=", start)
      .where("installments.due_date", "<=", end)
      .executeTakeFirstOrThrow();
    const collected = await db
      .selectFrom("effective_allocations")
      .innerJoin("payments", "payments.id", "effective_allocations.payment_id")
      .innerJoin("installments", "installments.id", "effective_allocations.installment_id")
      .innerJoin("enrolments", "enrolments.id", "installments.enrolment_id")
      .select(sql<number>`coalesce(sum(effective_allocations.amount), 0)::bigint`.as("total"))
      .where("enrolments.group_id", "=", id)
      .where(sql<string>`(payments.received_at at time zone ${centre.timezone})::date`, ">=", start)
      .where(sql<string>`(payments.received_at at time zone ${centre.timezone})::date`, "<=", end)
      .executeTakeFirstOrThrow();
    return {
      month,
      invoiced: Number(invoiced.charges) + Number(invoiced.discounts),
      collected: Number(collected.total),
      unpaid: Number(invoiced.unpaid),
      postponed: Number(invoiced.postponed),
    };
  });

  app.post("/:id/archive", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { reason } = archiveBody.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const enrolled = await trx.selectFrom("enrolments").select("id").where("group_id", "=", id).where("status", "=", "active").executeTakeFirst();
      if (enrolled) throw conflict("has_active_enrolments", "transfer or close the enrolments of this group first");
      const result = await trx
        .updateTable("groups")
        .set({ status: "archived", updated_at: new Date() })
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) throw notFound("group");
      await writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action: "group.archived", objectType: "group", objectId: id, reason });
    });
    return detail(id, actor.centreId);
  });
};
