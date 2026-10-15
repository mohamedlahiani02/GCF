import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { notFound, unprocessable } from "../errors.js";
import { archiveBody, clockTime, idParam, optionalEmail, optionalText, requiredText, toClock, uuid } from "../validation.js";

const availability = z
  .object({ weekday: z.number().int().min(1).max(7), startTime: clockTime, endTime: clockTime })
  .strict()
  .refine((a) => a.endTime > a.startTime, "the end time must be after the start time");

const fields = {
  firstName: requiredText(100),
  lastName: requiredText(100),
  kind: z.enum(["teacher", "trainer"]),
  employment: z.enum(["salaried", "freelance", "contractor"]),
  phone: optionalText(40),
  email: optionalEmail,
  notes: optionalText(2000),
  subjectIds: z.array(uuid).max(50),
  availability: z.array(availability).max(50),
};
const createBody = z.object(fields).strict();
const updateBody = z.object(fields).partial().strict();

export const instructorRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const read = app.requirePermission("instructors:read");
  const write = app.requirePermission("instructors:write");

  const load = async (id: string, centreId: string) => {
    const instructor = await db
      .selectFrom("instructors")
      .select(["id", "first_name as firstName", "last_name as lastName", "kind", "employment", "phone", "email", "notes", "status"])
      .where("id", "=", id)
      .where("centre_id", "=", centreId)
      .executeTakeFirst();
    if (!instructor) throw notFound("instructor");
    const subjects = await db
      .selectFrom("instructor_subjects")
      .innerJoin("subjects", "subjects.id", "instructor_subjects.subject_id")
      .select(["subjects.id", "subjects.name"])
      .where("instructor_id", "=", id)
      .orderBy("subjects.name")
      .execute();
    const slots = await db
      .selectFrom("instructor_availability")
      .select(["weekday", "start_time", "end_time"])
      .where("instructor_id", "=", id)
      .orderBy("weekday")
      .orderBy("start_time")
      .execute();
    return {
      ...instructor,
      subjects,
      availability: slots.map((s) => ({ weekday: s.weekday, startTime: toClock(s.start_time), endTime: toClock(s.end_time) })),
    };
  };

  const assertSubjects = async (subjectIds: string[], centreId: string) => {
    if (subjectIds.length === 0) return;
    const found = await db.selectFrom("subjects").select("id").where("centre_id", "=", centreId).where("id", "in", subjectIds).execute();
    if (found.length !== new Set(subjectIds).size) throw unprocessable("unknown_subject", "one of the subjects does not exist");
  };

  app.get("/", { preHandler: read }, async (request) => {
    const rows = await db
      .selectFrom("instructors")
      .leftJoin("groups", (join) => join.onRef("groups.instructor_id", "=", "instructors.id").on("groups.status", "=", "active"))
      .select([
        "instructors.id",
        "instructors.first_name as firstName",
        "instructors.last_name as lastName",
        "instructors.kind",
        "instructors.employment",
        "instructors.phone",
        "instructors.email",
        "instructors.status",
      ])
      .select((eb) => eb.fn.count<number>("groups.id").as("activeGroups"))
      .where("instructors.centre_id", "=", request.user!.centreId)
      .groupBy("instructors.id")
      .orderBy("instructors.last_name")
      .orderBy("instructors.first_name")
      .execute();
    return rows.map((r) => ({ ...r, activeGroups: Number(r.activeGroups) }));
  });

  app.get("/:id", { preHandler: read }, async (request) => {
    const { id } = idParam.parse(request.params);
    return load(id, request.user!.centreId);
  });

  app.post("/", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const body = createBody.parse(request.body);
    await assertSubjects(body.subjectIds, actor.centreId);
    const id = await db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto("instructors")
        .values({
          centre_id: actor.centreId,
          first_name: body.firstName,
          last_name: body.lastName,
          kind: body.kind,
          employment: body.employment,
          phone: body.phone ?? null,
          email: body.email ?? null,
          notes: body.notes ?? null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      if (body.subjectIds.length) {
        await trx
          .insertInto("instructor_subjects")
          .values([...new Set(body.subjectIds)].map((s) => ({ instructor_id: created.id, subject_id: s })))
          .execute();
      }
      if (body.availability.length) {
        await trx
          .insertInto("instructor_availability")
          .values(body.availability.map((a) => ({ instructor_id: created.id, weekday: a.weekday, start_time: a.startTime, end_time: a.endTime })))
          .execute();
      }
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "instructor.created",
        objectType: "instructor",
        objectId: created.id,
        after: body,
      });
      return created.id;
    });
    return reply.status(201).send(await load(id, actor.centreId));
  });

  app.patch("/:id", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = updateBody.parse(request.body);
    const before = await load(id, actor.centreId);
    if (body.subjectIds) await assertSubjects(body.subjectIds, actor.centreId);
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable("instructors")
        .set({
          ...(body.firstName === undefined ? {} : { first_name: body.firstName }),
          ...(body.lastName === undefined ? {} : { last_name: body.lastName }),
          ...(body.kind === undefined ? {} : { kind: body.kind }),
          ...(body.employment === undefined ? {} : { employment: body.employment }),
          ...(body.phone === undefined ? {} : { phone: body.phone }),
          ...(body.email === undefined ? {} : { email: body.email }),
          ...(body.notes === undefined ? {} : { notes: body.notes }),
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .execute();
      if (body.subjectIds) {
        await trx.deleteFrom("instructor_subjects").where("instructor_id", "=", id).execute();
        if (body.subjectIds.length) {
          await trx
            .insertInto("instructor_subjects")
            .values([...new Set(body.subjectIds)].map((s) => ({ instructor_id: id, subject_id: s })))
            .execute();
        }
      }
      if (body.availability) {
        await trx.deleteFrom("instructor_availability").where("instructor_id", "=", id).execute();
        if (body.availability.length) {
          await trx
            .insertInto("instructor_availability")
            .values(body.availability.map((a) => ({ instructor_id: id, weekday: a.weekday, start_time: a.startTime, end_time: a.endTime })))
            .execute();
        }
      }
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "instructor.updated",
        objectType: "instructor",
        objectId: id,
        before,
        after: body,
      });
    });
    return load(id, actor.centreId);
  });

  app.post("/:id/archive", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { reason } = archiveBody.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const active = await trx.selectFrom("groups").select("id").where("instructor_id", "=", id).where("status", "=", "active").executeTakeFirst();
      if (active) throw unprocessable("has_active_groups", "reassign the active groups of this instructor first");
      const result = await trx
        .updateTable("instructors")
        .set({ status: "archived", updated_at: new Date() })
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) throw notFound("instructor");
      await writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action: "instructor.archived", objectType: "instructor", objectId: id, reason });
    });
    return load(id, actor.centreId);
  });
};
