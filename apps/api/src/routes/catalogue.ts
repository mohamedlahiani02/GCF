import { planAmounts, ScheduleError, type PlanItemInput } from "@gcf/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { Database } from "../db/types.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { archiveBody, basisPoints, idParam, isoDate, millimes, optionalText, requiredText, uuid } from "../validation.js";

const subjectBody = z.object({ name: requiredText(100) }).strict();

const roomBody = z.object({ name: requiredText(100), capacity: z.number().int().min(1).max(10_000), equipment: optionalText(500) }).strict();

const studyFields = {
  subjectId: uuid,
  name: requiredText(150),
  billingMode: z.enum(["monthly", "per_session"]),
  price: millimes,
  absenceBilled: z.boolean(),
  sessionsPerWeek: z.number().int().min(1).max(14),
  capacity: z.number().int().min(1).max(1000),
};
const studyCreate = z.object(studyFields).strict();
const studyUpdate = z.object(studyFields).partial().strict();

const trainingFields = {
  title: requiredText(150),
  category: optionalText(100),
  description: optionalText(4000),
  durationHours: z.number().int().min(1).max(10_000),
  price: millimes,
  capacity: z.number().int().min(1).max(1000),
};
const trainingCreate = z.object(trainingFields).strict();
const trainingUpdate = z.object(trainingFields).partial().strict();

const planItem = z
  .object({
    label: requiredText(100),
    valueKind: z.enum(["percent", "amount"]),
    value: z.number().int().positive(),
    dueKind: z.enum(["relative", "fixed"]),
    dueOffsetDays: z.number().int().min(0).max(3650).nullable().optional(),
    dueDate: isoDate.nullable().optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.valueKind === "percent" && !basisPoints.safeParse(item.value).success) {
      ctx.addIssue({ code: "custom", message: "a percentage is given in basis points between 1 and 10000" });
    }
    if (item.dueKind === "relative" && (item.dueOffsetDays === undefined || item.dueOffsetDays === null)) {
      ctx.addIssue({ code: "custom", message: "a relative due date needs dueOffsetDays" });
    }
    if (item.dueKind === "fixed" && !item.dueDate) ctx.addIssue({ code: "custom", message: "a fixed due date needs dueDate" });
  });
/**
 * A training formula: paid in full (optionally at its own price), in instalments (items summing to the price),
 * monthly or per session (a tariff, and for sessions whether an absence is billed).
 */
const planBody = z
  .object({
    name: requiredText(100),
    isDefault: z.boolean(),
    kind: z.enum(["full", "installments", "monthly", "per_session"]).default("installments"),
    amount: millimes.nullable().optional(),
    absenceBilled: z.boolean().nullable().optional(),
    items: z.array(planItem).max(36).default([]),
  })
  .strict()
  .superRefine((p, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (p.kind === "installments" && p.items.length === 0) issue("an instalment formula needs at least one instalment");
    if (p.kind !== "installments" && p.items.length > 0) issue("only an instalment formula has instalments");
    if ((p.kind === "monthly" || p.kind === "per_session") && (p.amount === undefined || p.amount === null))
      issue("a monthly or per-session formula needs its tariff");
    if (p.kind === "installments" && p.amount !== undefined && p.amount !== null) issue("an instalment formula takes the training price");
    if ((p.kind === "per_session") !== (p.absenceBilled !== undefined && p.absenceBilled !== null))
      issue("say whether an absence is billed, for a per-session formula only");
  });
type PlanBody = z.infer<typeof planBody>;
const planColumns = (p: PlanBody) => ({
  name: p.name,
  is_default: p.isDefault,
  kind: p.kind,
  amount: p.kind === "installments" ? null : (p.amount ?? null),
  absence_billed: p.kind === "per_session" ? (p.absenceBilled ?? null) : null,
});
const planPreviewBody = z.object({ items: z.array(planItem).min(1).max(36) }).strict();

const sessionFields = { name: requiredText(100), startDate: isoDate, endDate: isoDate };
const sessionCreate = z
  .object(sessionFields)
  .strict()
  .refine((s) => s.endDate >= s.startDate, "the end date cannot be before the start date");
const sessionUpdate = z
  .object({ ...sessionFields, status: z.enum(["open", "closed"]) })
  .partial()
  .strict();

function toPlanInput(items: z.infer<typeof planItem>[]): PlanItemInput[] {
  return items.map((i) => ({
    label: i.label,
    valueKind: i.valueKind,
    value: i.value,
    dueKind: i.dueKind,
    dueOffsetDays: i.dueKind === "relative" ? (i.dueOffsetDays ?? null) : null,
    dueDate: i.dueKind === "fixed" ? (i.dueDate ?? null) : null,
  }));
}

function checkPlanTotal(price: number, items: PlanItemInput[]): number[] {
  try {
    return planAmounts(price, items);
  } catch (error) {
    if (error instanceof ScheduleError) throw unprocessable("plan_total_mismatch", error.message);
    throw error;
  }
}

async function savePlanItems(trx: Transaction<Database>, planId: string, items: PlanItemInput[]) {
  await trx
    .insertInto("payment_plan_items")
    .values(
      items.map((i, index) => ({
        plan_id: planId,
        position: index + 1,
        label: i.label,
        value_kind: i.valueKind,
        value: i.value,
        due_kind: i.dueKind,
        due_offset_days: i.dueOffsetDays ?? null,
        due_date: i.dueDate ?? null,
      })),
    )
    .execute();
}

export const catalogueRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const read = app.requirePermission("catalogue:read");
  const write = app.requirePermission("catalogue:write");

  /* Subjects */

  app.get("/subjects", { preHandler: read }, async (request) =>
    db.selectFrom("subjects").select(["id", "name", "status"]).where("centre_id", "=", request.user!.centreId).orderBy("name").execute(),
  );

  app.post("/subjects", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const body = subjectBody.parse(request.body);
    const row = await db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto("subjects")
        .values({ centre_id: actor.centreId, name: body.name })
        .returning(["id", "name", "status"])
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "subject.created",
        objectType: "subject",
        objectId: created.id,
        after: created,
      });
      return created;
    });
    return reply.status(201).send(row);
  });

  /* Rooms (tariffs and rentals live with the rental module) */

  app.get("/rooms", { preHandler: read }, async (request) =>
    db.selectFrom("rooms").select(["id", "name", "capacity", "equipment", "status"]).where("centre_id", "=", request.user!.centreId).orderBy("name").execute(),
  );

  app.post("/rooms", { preHandler: app.requirePermission("rooms:write") }, async (request, reply) => {
    const actor = request.user!;
    const body = roomBody.parse(request.body);
    const row = await db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto("rooms")
        .values({ centre_id: actor.centreId, name: body.name, capacity: body.capacity, equipment: body.equipment ?? null })
        .returning(["id", "name", "capacity", "equipment", "status"])
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "room.created",
        objectType: "room",
        objectId: created.id,
        after: created,
      });
      return created;
    });
    return reply.status(201).send(row);
  });

  /* Private studies */

  const studyColumns = [
    "id",
    "subject_id as subjectId",
    "name",
    "billing_mode as billingMode",
    "price",
    "absence_billed as absenceBilled",
    "sessions_per_week as sessionsPerWeek",
    "capacity",
    "status",
  ] as const;

  app.get("/studies", { preHandler: read }, async (request) => {
    return db
      .selectFrom("studies")
      .leftJoin("groups", (join) => join.onRef("groups.study_id", "=", "studies.id").on("groups.status", "=", "active"))
      .leftJoin("enrolments", (join) => join.onRef("enrolments.group_id", "=", "groups.id").on("enrolments.status", "=", "active"))
      .select([
        "studies.id",
        "studies.subject_id as subjectId",
        "studies.name",
        "studies.billing_mode as billingMode",
        "studies.price",
        "studies.absence_billed as absenceBilled",
        "studies.sessions_per_week as sessionsPerWeek",
        "studies.capacity",
        "studies.status",
      ])
      .select((eb) => [eb.fn.count<number>("groups.id").distinct().as("groupCount"), eb.fn.count<number>("enrolments.id").distinct().as("studentCount")])
      .where("studies.centre_id", "=", request.user!.centreId)
      .groupBy("studies.id")
      .orderBy("studies.name")
      .execute()
      .then((rows) => rows.map((r) => ({ ...r, groupCount: Number(r.groupCount), studentCount: Number(r.studentCount) })));
  });

  app.post("/studies", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const body = studyCreate.parse(request.body);
    const subject = await db.selectFrom("subjects").select("id").where("id", "=", body.subjectId).where("centre_id", "=", actor.centreId).executeTakeFirst();
    if (!subject) throw notFound("subject");
    const row = await db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto("studies")
        .values({
          centre_id: actor.centreId,
          subject_id: body.subjectId,
          name: body.name,
          billing_mode: body.billingMode,
          price: body.price,
          absence_billed: body.absenceBilled,
          sessions_per_week: body.sessionsPerWeek,
          capacity: body.capacity,
        })
        .returning(studyColumns)
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "study.created",
        objectType: "study",
        objectId: created.id,
        after: created,
      });
      return created;
    });
    return reply.status(201).send(row);
  });

  app.patch("/studies/:id", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = studyUpdate.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom("studies")
        .select(studyColumns)
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw notFound("study");
      if (body.subjectId) {
        const subject = await trx
          .selectFrom("subjects")
          .select("id")
          .where("id", "=", body.subjectId)
          .where("centre_id", "=", actor.centreId)
          .executeTakeFirst();
        if (!subject) throw notFound("subject");
      }
      if (body.billingMode && body.billingMode !== before.billingMode) {
        const used = await trx
          .selectFrom("enrolments")
          .innerJoin("groups", "groups.id", "enrolments.group_id")
          .select("enrolments.id")
          .where("groups.study_id", "=", id)
          .executeTakeFirst();
        if (used) throw conflict("billing_mode_locked", "the billing mode cannot change once students are enrolled");
      }
      const after = await trx
        .updateTable("studies")
        .set({
          ...(body.subjectId === undefined ? {} : { subject_id: body.subjectId }),
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.billingMode === undefined ? {} : { billing_mode: body.billingMode }),
          ...(body.price === undefined ? {} : { price: body.price }),
          ...(body.absenceBilled === undefined ? {} : { absence_billed: body.absenceBilled }),
          ...(body.sessionsPerWeek === undefined ? {} : { sessions_per_week: body.sessionsPerWeek }),
          ...(body.capacity === undefined ? {} : { capacity: body.capacity }),
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .returning(studyColumns)
        .executeTakeFirstOrThrow();
      await writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action: "study.updated", objectType: "study", objectId: id, before, after });
      return after;
    });
  });

  app.post("/studies/:id/archive", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { reason } = archiveBody.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const active = await trx.selectFrom("groups").select("id").where("study_id", "=", id).where("status", "=", "active").executeTakeFirst();
      if (active) throw conflict("has_active_groups", "archive the groups of this study first");
      const after = await trx
        .updateTable("studies")
        .set({ status: "archived", updated_at: new Date() })
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .returning(studyColumns)
        .executeTakeFirst();
      if (!after) throw notFound("study");
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "study.archived",
        objectType: "study",
        objectId: id,
        after: { status: "archived" },
        reason,
      });
      return after;
    });
  });

  /* Trainings, payment plans and sessions */

  const trainingColumns = ["id", "title", "category", "description", "duration_hours as durationHours", "price", "capacity", "status"] as const;

  app.get("/trainings", { preHandler: read }, async (request) => {
    const rows = await db
      .selectFrom("trainings")
      .leftJoin("training_sessions", (join) => join.onRef("training_sessions.training_id", "=", "trainings.id").on("training_sessions.status", "=", "open"))
      .select([
        "trainings.id",
        "trainings.title",
        "trainings.category",
        "trainings.duration_hours as durationHours",
        "trainings.price",
        "trainings.capacity",
        "trainings.status",
      ])
      .select((eb) => [
        eb.fn.count<number>("training_sessions.id").distinct().as("openSessions"),
        eb
          .selectFrom("payment_plans")
          .select(sql<string[]>`coalesce(array_agg(distinct payment_plans.kind), '{}')`.as("kinds"))
          .whereRef("payment_plans.training_id", "=", "trainings.id")
          .where("payment_plans.status", "=", "active")
          .as("formulaKinds"),
      ])
      .where("trainings.centre_id", "=", request.user!.centreId)
      .groupBy("trainings.id")
      .orderBy("trainings.title")
      .execute();
    return rows.map((r) => ({ ...r, openSessions: Number(r.openSessions), formulaKinds: r.formulaKinds ?? [] }));
  });

  app.get("/trainings/:id", { preHandler: read }, async (request) => {
    const { id } = idParam.parse(request.params);
    const training = await db
      .selectFrom("trainings")
      .select(trainingColumns)
      .where("id", "=", id)
      .where("centre_id", "=", request.user!.centreId)
      .executeTakeFirst();
    if (!training) throw notFound("training");
    const plans = await db
      .selectFrom("payment_plans")
      .select(["id", "name", "is_default as isDefault", "kind", "amount", "absence_billed as absenceBilled", "status"])
      .where("training_id", "=", id)
      .orderBy("name")
      .execute();
    const items = plans.length
      ? await db
          .selectFrom("payment_plan_items")
          .select([
            "plan_id as planId",
            "position",
            "label",
            "value_kind as valueKind",
            "value",
            "due_kind as dueKind",
            "due_offset_days as dueOffsetDays",
            "due_date as dueDate",
          ])
          .where(
            "plan_id",
            "in",
            plans.map((p) => p.id),
          )
          .orderBy("plan_id")
          .orderBy("position")
          .execute()
      : [];
    const sessions = await db
      .selectFrom("training_sessions")
      .select(["id", "name", "start_date as startDate", "end_date as endDate", "status"])
      .where("training_id", "=", id)
      .orderBy("start_date", "desc")
      .execute();
    return {
      ...training,
      plans: plans.map((p) => {
        const planItems = items.filter((i) => i.planId === p.id).map(({ planId: _planId, ...rest }) => rest);
        const amounts = p.kind === "installments" ? planAmounts(training.price, planItems) : p.kind === "full" ? [p.amount ?? training.price] : [];
        return { ...p, items: planItems, amounts };
      }),
      sessions,
    };
  });

  app.post("/trainings", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const body = trainingCreate.parse(request.body);
    const row = await db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto("trainings")
        .values({
          centre_id: actor.centreId,
          title: body.title,
          category: body.category ?? null,
          description: body.description ?? null,
          duration_hours: body.durationHours,
          price: body.price,
          capacity: body.capacity,
        })
        .returning(trainingColumns)
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "training.created",
        objectType: "training",
        objectId: created.id,
        after: created,
      });
      return created;
    });
    return reply.status(201).send(row);
  });

  app.patch("/trainings/:id", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = trainingUpdate.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom("trainings")
        .select(trainingColumns)
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw notFound("training");
      if (body.price !== undefined && body.price !== before.price) {
        // Every active plan must still add up to the new price.
        const plans = await trx.selectFrom("payment_plans").select("id").where("training_id", "=", id).where("status", "=", "active").execute();
        for (const plan of plans) {
          const items = await trx
            .selectFrom("payment_plan_items")
            .select(["label", "value_kind as valueKind", "value", "due_kind as dueKind", "due_offset_days as dueOffsetDays", "due_date as dueDate"])
            .where("plan_id", "=", plan.id)
            .orderBy("position")
            .execute();
          checkPlanTotal(body.price, items);
        }
      }
      const after = await trx
        .updateTable("trainings")
        .set({
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.category === undefined ? {} : { category: body.category }),
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.durationHours === undefined ? {} : { duration_hours: body.durationHours }),
          ...(body.price === undefined ? {} : { price: body.price }),
          ...(body.capacity === undefined ? {} : { capacity: body.capacity }),
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .returning(trainingColumns)
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "training.updated",
        objectType: "training",
        objectId: id,
        before,
        after,
      });
      return after;
    });
  });

  const loadTraining = async (id: string, centreId: string) => {
    const training = await db.selectFrom("trainings").select(["id", "price"]).where("id", "=", id).where("centre_id", "=", centreId).executeTakeFirst();
    if (!training) throw notFound("training");
    return training;
  };

  /** Live total check used by the plan editor. */
  app.post("/trainings/:id/plans/preview", { preHandler: read }, async (request) => {
    const { id } = idParam.parse(request.params);
    const training = await loadTraining(id, request.user!.centreId);
    const { items } = planPreviewBody.parse(request.body);
    try {
      const amounts = planAmounts(training.price, toPlanInput(items));
      return { valid: true, price: training.price, amounts, total: amounts.reduce((s, a) => s + a, 0) };
    } catch (error) {
      if (error instanceof ScheduleError) return { valid: false, price: training.price, message: error.message };
      throw error;
    }
  });

  app.post("/trainings/:id/plans", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const training = await loadTraining(id, actor.centreId);
    const body = planBody.parse(request.body);
    const items = toPlanInput(body.items);
    if (body.kind === "installments") checkPlanTotal(training.price, items);
    const plan = await db.transaction().execute(async (trx) => {
      if (body.isDefault) {
        await trx.updateTable("payment_plans").set({ is_default: false }).where("training_id", "=", id).where("is_default", "=", true).execute();
      }
      const created = await trx
        .insertInto("payment_plans")
        .values({ centre_id: actor.centreId, training_id: id, ...planColumns(body) })
        .returning(["id", "name", "is_default as isDefault", "kind", "amount", "absence_billed as absenceBilled", "status"])
        .executeTakeFirstOrThrow();
      if (items.length) await savePlanItems(trx, created.id, items);
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "payment_plan.created",
        objectType: "payment_plan",
        objectId: created.id,
        after: { ...created, items },
      });
      return created;
    });
    return reply.status(201).send(plan);
  });

  /**
   * Replaces the items of a plan. Schedules already generated for enrolled students keep their own instalments:
   * a plan only describes how future enrolments are invoiced.
   */
  app.put("/plans/:id", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = planBody.parse(request.body);
    const items = toPlanInput(body.items);
    return db.transaction().execute(async (trx) => {
      const plan = await trx
        .selectFrom("payment_plans")
        .innerJoin("trainings", "trainings.id", "payment_plans.training_id")
        .select(["payment_plans.id", "payment_plans.training_id as trainingId", "trainings.price"])
        .where("payment_plans.id", "=", id)
        .where("payment_plans.centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!plan) throw notFound("payment plan");
      if (body.kind === "installments") checkPlanTotal(plan.price, items);
      if (body.isDefault) {
        await trx.updateTable("payment_plans").set({ is_default: false }).where("training_id", "=", plan.trainingId).where("id", "!=", id).execute();
      }
      await trx.updateTable("payment_plans").set(planColumns(body)).where("id", "=", id).execute();
      await trx.deleteFrom("payment_plan_items").where("plan_id", "=", id).execute();
      if (items.length) await savePlanItems(trx, id, items);
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "payment_plan.updated",
        objectType: "payment_plan",
        objectId: id,
        after: { ...planColumns(body), items },
      });
      const saved = planColumns(body);
      return {
        id,
        name: saved.name,
        isDefault: saved.is_default,
        kind: saved.kind,
        amount: saved.amount,
        absenceBilled: saved.absence_billed,
        status: "active",
      };
    });
  });

  app.post("/plans/:id/archive", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { reason } = archiveBody.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable("payment_plans")
        .set({ status: "archived", is_default: false })
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .returning(["id", "name", "is_default as isDefault", "status"])
        .executeTakeFirst();
      if (!row) throw notFound("payment plan");
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "payment_plan.archived",
        objectType: "payment_plan",
        objectId: id,
        reason,
      });
      return row;
    });
  });

  app.post("/trainings/:id/sessions", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    await loadTraining(id, actor.centreId);
    const body = sessionCreate.parse(request.body);
    const row = await db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto("training_sessions")
        .values({ centre_id: actor.centreId, training_id: id, name: body.name, start_date: body.startDate, end_date: body.endDate })
        .returning(["id", "name", "start_date as startDate", "end_date as endDate", "status"])
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "training_session.created",
        objectType: "training_session",
        objectId: created.id,
        after: created,
      });
      return created;
    });
    return reply.status(201).send(row);
  });

  app.patch("/training-sessions/:id", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = sessionUpdate.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom("training_sessions")
        .select(["id", "name", "start_date as startDate", "end_date as endDate", "status"])
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw notFound("training session");
      const startDate = body.startDate ?? before.startDate;
      const endDate = body.endDate ?? before.endDate;
      if (endDate < startDate) throw unprocessable("invalid_dates", "the end date cannot be before the start date");
      const after = await trx
        .updateTable("training_sessions")
        .set({ name: body.name ?? before.name, start_date: startDate, end_date: endDate, status: body.status ?? before.status })
        .where("id", "=", id)
        .returning(["id", "name", "start_date as startDate", "end_date as endDate", "status"])
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "training_session.updated",
        objectType: "training_session",
        objectId: id,
        before,
        after,
      });
      return after;
    });
  });
};
