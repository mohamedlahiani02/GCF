import { ATTENDANCE_STATUSES } from "@gcf/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { groupAttendance, loadSession, saveRecords, sheetRows, syncSessionCharges } from "../domain/attendance.js";
import { renderAttendanceSheet } from "../domain/attendanceSheetPdf.js";
import { cancelSession, createSingleSession, generateGroupSessions, moveSession } from "../domain/sessions.js";
import { conflict, unprocessable } from "../errors.js";
import { clockTime, idParam, isoDate, reason, uuid } from "../validation.js";

const generateBody = z.object({ from: isoDate, to: isoDate, skipConflicts: z.boolean().default(false) }).strict();
const singleBody = z
  .object({ date: isoDate, startTime: clockTime, endTime: clockTime, roomId: uuid.nullable().optional(), instructorId: uuid.optional() })
  .strict()
  .refine((s) => s.endTime > s.startTime, "the end time must be after the start time");
const moveBody = z
  .object({ startsAt: z.iso.datetime({ offset: true }), endsAt: z.iso.datetime({ offset: true }), roomId: uuid.nullable(), instructorId: uuid.optional() })
  .strict();
const cancelBody = z.object({ reason }).strict();
const record = z
  .object({
    studentId: uuid,
    status: z.enum(ATTENDANCE_STATUSES),
    note: z.string().trim().max(500).nullable().optional(),
    hostSessionId: uuid.nullable().optional(),
  })
  .strict();
const recordsBody = z.object({ records: z.array(record).max(500) }).strict();
const correctBody = record.extend({ reason }).strict();
const dayQuery = z.object({ date: isoDate });
const rangeQuery = z.object({ from: isoDate, to: isoDate });

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const planningWrite = app.requirePermission("groups:write");
  const attendanceRead = app.requirePermission("attendance:read");
  const attendanceWrite = app.requirePermission("attendance:write");

  /** Home of the attendance module: the day's sessions and the state of their sheet. */
  app.get("/sessions", { preHandler: attendanceRead }, async (request) => {
    const { date } = dayQuery.parse(request.query);
    const centreId = request.user!.centreId;
    const centre = await db.selectFrom("centres").select("timezone").where("id", "=", centreId).executeTakeFirstOrThrow();
    return db
      .selectFrom("class_sessions")
      .innerJoin("groups", "groups.id", "class_sessions.group_id")
      .innerJoin("instructors", "instructors.id", "class_sessions.instructor_id")
      .leftJoin("rooms", "rooms.id", "class_sessions.room_id")
      .select([
        "class_sessions.id",
        "class_sessions.group_id as groupId",
        "groups.name as groupName",
        "class_sessions.starts_at as startsAt",
        "class_sessions.ends_at as endsAt",
        "instructors.first_name as instructorFirstName",
        "instructors.last_name as instructorLastName",
        "rooms.name as roomName",
        "class_sessions.status",
        "class_sessions.sheet_status as sheetStatus",
      ])
      .where("class_sessions.centre_id", "=", centreId)
      .where(sql<string>`(class_sessions.starts_at at time zone ${centre.timezone})::date`, "=", date)
      .orderBy("class_sessions.starts_at")
      .execute();
  });

  app.post("/groups/:id/sessions/generate", { preHandler: planningWrite }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = generateBody.parse(request.body);
    if (body.to < body.from) throw unprocessable("invalid_range", "the end date cannot be before the start date");
    return db.transaction().execute(async (trx) => {
      const result = await generateGroupSessions(trx, actor.centreId, id, body.from, body.to, body.skipConflicts);
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "group.sessions_generated",
        objectType: "group",
        objectId: id,
        after: { ...body, created: result.created, conflicts: result.conflicts.length },
      });
      return result;
    });
  });

  /** A group's sessions over a period (all of them by default), with the state of their attendance sheet. */
  app.get("/groups/:id/sessions", { preHandler: attendanceRead }, async (request) => {
    const centreId = request.user!.centreId;
    const { id } = idParam.parse(request.params);
    const q = z.object({ from: isoDate.optional(), to: isoDate.optional() }).parse(request.query);
    const centre = await db.selectFrom("centres").select("timezone").where("id", "=", centreId).executeTakeFirstOrThrow();
    const localDay = sql<string>`(class_sessions.starts_at at time zone ${centre.timezone})::date`;
    return db
      .selectFrom("class_sessions")
      .innerJoin("instructors", "instructors.id", "class_sessions.instructor_id")
      .leftJoin("rooms", "rooms.id", "class_sessions.room_id")
      .select([
        "class_sessions.id",
        "class_sessions.starts_at as startsAt",
        "class_sessions.ends_at as endsAt",
        "class_sessions.status",
        "class_sessions.sheet_status as sheetStatus",
        "class_sessions.room_id as roomId",
        "rooms.name as roomName",
        "class_sessions.instructor_id as instructorId",
        sql<string>`instructors.first_name || ' ' || instructors.last_name`.as("instructorName"),
      ])
      .where("class_sessions.group_id", "=", id)
      .where("class_sessions.centre_id", "=", centreId)
      .$if(q.from !== undefined, (qb) => qb.where(localDay, ">=", q.from!))
      .$if(q.to !== undefined, (qb) => qb.where(localDay, "<=", q.to!))
      .orderBy("class_sessions.starts_at")
      .execute();
  });

  app.post("/groups/:id/sessions", { preHandler: planningWrite }, async (request, reply) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = singleBody.parse(request.body);
    const sessionId = await db.transaction().execute(async (trx) => {
      const created = await createSingleSession(trx, actor.centreId, id, {
        date: body.date,
        startTime: body.startTime,
        endTime: body.endTime,
        roomId: body.roomId ?? null,
        instructorId: body.instructorId,
      });
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "session.created",
        objectType: "session",
        objectId: created,
        after: body,
      });
      return created;
    });
    return reply.status(201).send({ id: sessionId });
  });

  app.patch("/sessions/:id/move", { preHandler: planningWrite }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = moveBody.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const before = await loadSession(trx, id, actor.centreId);
      await moveSession(trx, actor.centreId, id, {
        startsAt: new Date(body.startsAt),
        endsAt: new Date(body.endsAt),
        roomId: body.roomId,
        instructorId: body.instructorId,
      });
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "session.moved",
        objectType: "session",
        objectId: id,
        before: { startsAt: before.startsAt, endsAt: before.endsAt, roomId: before.roomId, instructorId: before.instructorId },
        after: body,
      });
    });
    return { id };
  });

  app.post("/sessions/:id/cancel", { preHandler: planningWrite }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = cancelBody.parse(request.body);
    await db.transaction().execute(async (trx) => {
      await cancelSession(trx, actor.centreId, id, body.reason);
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "session.cancelled",
        objectType: "session",
        objectId: id,
        reason: body.reason,
      });
    });
    return { id, status: "cancelled" };
  });

  app.get("/sessions/:id/sheet", { preHandler: attendanceRead }, async (request) => {
    const { id } = idParam.parse(request.params);
    const session = await loadSession(db, id, request.user!.centreId);
    const rows = await sheetRows(db, session);
    const counted = rows.filter((r) => !r.isGuest);
    return {
      session: {
        id: session.id,
        groupId: session.groupId,
        groupName: session.groupName,
        instructorId: session.instructorId,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        localDate: session.localDate,
        status: session.status,
        sheetStatus: session.sheetStatus,
      },
      rows,
      counters: {
        present: counted.filter((r) => r.status === "present").length,
        absent: counted.filter((r) => r.status === "absent").length,
        absentJustified: counted.filter((r) => r.status === "absent_justified").length,
        presentOtherGroup: counted.filter((r) => r.status === "present_other_group").length,
        guests: rows.length - counted.length,
      },
    };
  });

  app.put("/sessions/:id/attendance", { preHandler: attendanceWrite }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = recordsBody.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const session = await loadSession(trx, id, actor.centreId, true);
      if (session.sheetStatus === "validated") throw conflict("sheet_validated", "the sheet is validated; only an admin can correct it, with a reason");
      await saveRecords(trx, session, body.records, actor.userId);
    });
    return { id, saved: body.records.length };
  });

  /** Locks the sheet. Students without a saved status are recorded as present, the sheet's default. */
  app.post("/sessions/:id/validate", { preHandler: attendanceWrite }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    return db.transaction().execute(async (trx) => {
      const session = await loadSession(trx, id, actor.centreId, true);
      if (session.status === "cancelled") throw conflict("session_cancelled", "the session is cancelled");
      if (session.sheetStatus === "validated") throw conflict("sheet_validated", "the sheet is already validated");
      if (session.startsAt.getTime() > Date.now()) throw unprocessable("session_not_started", "a sheet can be validated once the session has started");
      const rows = await sheetRows(trx, session);
      const missing = rows.filter((r) => !r.saved && !r.isGuest);
      if (missing.length)
        await saveRecords(
          trx,
          session,
          missing.map((r) => ({ studentId: r.studentId, status: "present" as const })),
          actor.userId,
        );
      await trx
        .updateTable("class_sessions")
        .set({ sheet_status: "validated", status: "held", validated_at: new Date(), validated_by: actor.userId })
        .where("id", "=", id)
        .execute();
      await syncSessionCharges(trx, { ...session, sheetStatus: "validated", status: "held" }, actor.userId);
      await writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action: "attendance.validated", objectType: "session", objectId: id });
      return { id, sheetStatus: "validated" };
    });
  });

  app.post("/sessions/:id/attendance/correct", { preHandler: app.requirePermission("attendance:correct") }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = correctBody.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const session = await loadSession(trx, id, actor.centreId, true);
      if (session.sheetStatus !== "validated") throw conflict("sheet_not_validated", "use the normal sheet until it is validated");
      const before = await trx
        .selectFrom("attendance_records")
        .select(["status", "note", "host_session_id"])
        .where("session_id", "=", id)
        .where("student_id", "=", body.studentId)
        .executeTakeFirst();
      await saveRecords(trx, session, [body], actor.userId);
      await syncSessionCharges(trx, session, actor.userId);
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "attendance.corrected",
        objectType: "session",
        objectId: id,
        before: before ?? null,
        after: { studentId: body.studentId, status: body.status, note: body.note ?? null },
        reason: body.reason,
      });
      return { id, studentId: body.studentId, status: body.status };
    });
  });

  app.get("/sessions/:id/sheet.pdf", { preHandler: attendanceRead }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const centreId = request.user!.centreId;
    const session = await loadSession(db, id, centreId);
    const details = await db
      .selectFrom("class_sessions")
      .innerJoin("instructors", "instructors.id", "class_sessions.instructor_id")
      .innerJoin("centres", "centres.id", "class_sessions.centre_id")
      .leftJoin("rooms", "rooms.id", "class_sessions.room_id")
      .select([
        "centres.name as centreName",
        "instructors.first_name as firstName",
        "instructors.last_name as lastName",
        "rooms.name as roomName",
        sql<string>`to_char(class_sessions.starts_at at time zone centres.timezone, 'DD/MM/YYYY HH24:MI')`.as("start"),
        sql<string>`to_char(class_sessions.ends_at at time zone centres.timezone, 'HH24:MI')`.as("end"),
      ])
      .where("class_sessions.id", "=", id)
      .executeTakeFirstOrThrow();
    const rows = await sheetRows(db, session);
    const pdf = await renderAttendanceSheet({
      centreName: details.centreName,
      groupName: session.groupName,
      sessionLabel: `${details.start} - ${details.end}`,
      instructorName: `${details.firstName} ${details.lastName}`,
      roomName: details.roomName,
      students: rows.map((r) => ({ lastName: r.lastName, firstName: r.firstName, guestOf: r.isGuest ? r.originGroupName : null })),
      blankRows: 4,
    });
    return reply.header("content-type", "application/pdf").header("content-disposition", `inline; filename="presence-${session.localDate}.pdf"`).send(pdf);
  });

  app.get("/groups/:id/attendance", { preHandler: attendanceRead }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { from, to } = rangeQuery.parse(request.query);
    return groupAttendance(db, id, request.user!.centreId, from, to);
  });
};
