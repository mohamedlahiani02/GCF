import { isIsoDate, isMinor, todayIn } from "@gcf/shared";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { Student } from "../db/types.js";
import { notFound, unprocessable } from "../errors.js";

const optionalText = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === "" ? null : v)).nullable().optional();
const optionalEmail = z
  .union([z.literal(""), z.string().trim().toLowerCase().email().max(254)])
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional();

const studentFields = {
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  birthDate: z.string().refine(isIsoDate, "expected a valid YYYY-MM-DD date").nullable().optional(),
  phone: optionalText(40),
  email: optionalEmail,
  receiptEmail: optionalEmail,
  guardianName: optionalText(200),
  guardianPhone: optionalText(40),
  guardianEmail: optionalEmail,
  notes: optionalText(2000),
};
const createBody = z.object(studentFields).strict();
const updateBody = z.object(studentFields).partial().strict();
const archiveBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["active", "archived", "all"]).default("active"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const present = (s: Student) => ({
  id: s.id,
  firstName: s.first_name,
  lastName: s.last_name,
  birthDate: s.birth_date,
  phone: s.phone,
  email: s.email,
  receiptEmail: s.receipt_email,
  guardianName: s.guardian_name,
  guardianPhone: s.guardian_phone,
  guardianEmail: s.guardian_email,
  notes: s.notes,
  status: s.status,
  createdAt: s.created_at,
  updatedAt: s.updated_at,
});

type StudentView = ReturnType<typeof present>;

/** A minor must have a guardian with at least one way to reach them (specification 5.3). */
function assertGuardianWhenMinor(student: Pick<StudentView, "birthDate" | "guardianName" | "guardianPhone" | "guardianEmail">, today: string, majorityAge: number) {
  if (!student.birthDate || !isMinor(student.birthDate, today, majorityAge)) return;
  if (!student.guardianName || (!student.guardianPhone && !student.guardianEmail)) {
    throw unprocessable("guardian_required", "a minor student needs a guardian name and a guardian phone or e-mail");
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export const studentRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;

  const centreRules = async (centreId: string) => {
    const centre = await db.selectFrom("centres").select(["timezone", "majority_age"]).where("id", "=", centreId).executeTakeFirstOrThrow();
    return { today: todayIn(centre.timezone), majorityAge: centre.majority_age };
  };

  app.get("/", { preHandler: app.requirePermission("students:read") }, async (request) => {
    const query = listQuery.parse(request.query);
    let base = db.selectFrom("students").where("centre_id", "=", request.user!.centreId);
    if (query.status !== "all") base = base.where("status", "=", query.status);
    if (query.q) {
      const pattern = `%${escapeLike(query.q.toLowerCase())}%`;
      base = base.where((eb) =>
        eb.or([
          eb(sql`lower(first_name || ' ' || last_name)`, "like", pattern),
          eb(sql`lower(last_name || ' ' || first_name)`, "like", pattern),
          eb(sql`coalesce(phone, '')`, "like", pattern),
          eb(sql`lower(coalesce(email, ''))`, "like", pattern),
        ]),
      );
    }
    const [{ total }] = (await base.select((eb) => eb.fn.countAll<number>().as("total")).execute()) as [{ total: number }];
    const rows = await base
      .selectAll()
      .orderBy(sql`lower(last_name)`)
      .orderBy(sql`lower(first_name)`)
      .orderBy("id")
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .execute();
    return { items: rows.map(present), total: Number(total), page: query.page, pageSize: query.pageSize };
  });

  app.get("/:id", { preHandler: app.requirePermission("students:read") }, async (request) => {
    const { id } = idParam.parse(request.params);
    const row = await db.selectFrom("students").selectAll().where("id", "=", id).where("centre_id", "=", request.user!.centreId).executeTakeFirst();
    if (!row) throw notFound("student");
    return present(row);
  });

  app.post("/", { preHandler: app.requirePermission("students:write") }, async (request, reply) => {
    const actor = request.user!;
    const body = createBody.parse(request.body);
    const rules = await centreRules(actor.centreId);
    assertGuardianWhenMinor(
      {
        birthDate: body.birthDate ?? null,
        guardianName: body.guardianName ?? null,
        guardianPhone: body.guardianPhone ?? null,
        guardianEmail: body.guardianEmail ?? null,
      },
      rules.today,
      rules.majorityAge,
    );
    const created = await db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto("students")
        .values({
          centre_id: actor.centreId,
          first_name: body.firstName,
          last_name: body.lastName,
          birth_date: body.birthDate ?? null,
          phone: body.phone ?? null,
          email: body.email ?? null,
          receipt_email: body.receiptEmail ?? null,
          guardian_name: body.guardianName ?? null,
          guardian_phone: body.guardianPhone ?? null,
          guardian_email: body.guardianEmail ?? null,
          notes: body.notes ?? null,
          created_by: actor.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "student.created",
        objectType: "student",
        objectId: row.id,
        after: present(row),
      });
      return row;
    });
    return reply.status(201).send(present(created));
  });

  app.patch("/:id", { preHandler: app.requirePermission("students:write") }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = updateBody.parse(request.body);
    const rules = await centreRules(actor.centreId);
    const updated = await db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom("students").selectAll().where("id", "=", id).where("centre_id", "=", actor.centreId).forUpdate().executeTakeFirst();
      if (!before) throw notFound("student");
      const beforeView = present(before);
      const merged = { ...beforeView, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) } as StudentView;
      assertGuardianWhenMinor(merged, rules.today, rules.majorityAge);
      const after = await trx
        .updateTable("students")
        .set({
          first_name: merged.firstName,
          last_name: merged.lastName,
          birth_date: merged.birthDate,
          phone: merged.phone,
          email: merged.email,
          receipt_email: merged.receiptEmail,
          guardian_name: merged.guardianName,
          guardian_phone: merged.guardianPhone,
          guardian_email: merged.guardianEmail,
          notes: merged.notes,
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "student.updated",
        objectType: "student",
        objectId: id,
        before: beforeView,
        after: present(after),
      });
      return after;
    });
    return present(updated);
  });

  const setStatus = (status: "active" | "archived") => async (request: FastifyRequest) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { reason } = archiveBody.parse(request.body);
    const updated = await db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom("students").selectAll().where("id", "=", id).where("centre_id", "=", actor.centreId).forUpdate().executeTakeFirst();
      if (!before) throw notFound("student");
      if (before.status === status) return before;
      const after = await trx.updateTable("students").set({ status, updated_at: new Date() }).where("id", "=", id).returningAll().executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: status === "archived" ? "student.archived" : "student.restored",
        objectType: "student",
        objectId: id,
        before: { status: before.status },
        after: { status },
        reason,
      });
      return after;
    });
    return present(updated);
  };

  app.post("/:id/archive", { preHandler: app.requirePermission("students:write") }, setStatus("archived"));
  app.post("/:id/restore", { preHandler: app.requirePermission("students:write") }, setStatus("active"));
};
