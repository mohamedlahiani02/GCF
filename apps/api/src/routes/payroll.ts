import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { PayBaseKind, PayPeriodicity } from "../db/types.js";
import { centreClock } from "../domain/ledger.js";
import { addAdjustment, calculateItems, cancelItem, cancelSettlement, settledAmounts, settleItems, validateItems } from "../domain/payItems.js";
import { computeCandidates, monthBounds } from "../domain/payrollCalc.js";
import { notFound, unprocessable } from "../errors.js";
import { basisPoints, idParam, isoDate, millimes, reason, uuid, yearMonth } from "../validation.js";

/** The rhythm each base can be paid at; the first one is the default. */
const PERIODICITIES: Record<PayBaseKind, PayPeriodicity[]> = {
  fixed_per_session: ["session", "month"],
  pct_session_tariff: ["session", "month"],
  hourly: ["month", "session"],
  pct_collections: ["month"],
  monthly_flat: ["month"],
  training_flat: ["training"],
};

const ruleBody = z
  .object({
    instructorId: uuid,
    scope: z.enum(["instructor", "study", "training", "group"]),
    scopeId: uuid.optional(),
    baseKind: z.enum(["pct_collections", "pct_session_tariff", "fixed_per_session", "monthly_flat", "hourly", "training_flat"]),
    basisPoints: basisPoints.optional(),
    amount: millimes.optional(),
    collectionBasis: z.enum(["collected", "invoiced"]).optional(),
    presenceKind: z.enum(["ignore", "prorata", "session_due", "threshold"]),
    minRateBasisPoints: basisPoints.optional(),
    floorAmount: millimes.optional(),
    prorataAbove: z.boolean().optional(),
    periodicity: z.enum(["session", "month", "training"]).optional(),
    validFrom: isoDate,
    validTo: isoDate.optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if ((r.scope === "instructor") === !!r.scopeId) issue("scopeId is required for a study, training or group rule, and forbidden for an instructor default");
    const pct = r.baseKind === "pct_collections" || r.baseKind === "pct_session_tariff";
    if (pct !== (r.basisPoints !== undefined)) issue("basisPoints is required for a percentage base only");
    if ((r.baseKind !== "pct_collections") !== (r.amount !== undefined)) issue("amount is required for every base except a percentage of collections");
    if ((r.baseKind === "pct_collections") !== (r.collectionBasis !== undefined)) issue("collectionBasis is required for a percentage of collections only");
    if ((r.presenceKind === "threshold") !== (r.minRateBasisPoints !== undefined && r.prorataAbove !== undefined))
      issue("a threshold needs minRateBasisPoints and prorataAbove");
    if (r.presenceKind !== "threshold" && r.floorAmount !== undefined) issue("a floor only applies to a threshold");
    if (r.validTo && r.validTo < r.validFrom) issue("validTo cannot be before validFrom");
    if (r.periodicity !== undefined && !PERIODICITIES[r.baseKind].includes(r.periodicity)) issue("this periodicity does not fit the base of the rule");
  });
const rulesQuery = z.object({ instructorId: uuid.optional() });
const monthQuery = z.object({ month: yearMonth });
const calculateBody = z.object({ instructorId: uuid, month: yearMonth }).strict();
const itemIdsBody = z.object({ itemIds: z.array(uuid).min(1).max(500) }).strict();
const cancelBody = z.object({ reason }).strict();
const adjustmentBody = z.object({ instructorId: uuid, month: yearMonth, kind: z.enum(["bonus", "deduction"]), amount: millimes.min(1), reason }).strict();
const settlementBody = z
  .object({
    instructorId: uuid,
    paidOn: isoDate,
    method: z.enum(["cash", "transfer", "cheque"]),
    reference: z.string().trim().max(100).optional(),
    lines: z
      .array(
        z
          .object({
            itemId: uuid,
            amount: z
              .number()
              .int()
              .refine((n) => Number.isSafeInteger(n) && n !== 0, "a non-zero amount in millimes"),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

export const payrollRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const read = app.requirePermission("payroll:read");
  const calculate = app.requirePermission("payroll:calculate");

  /* Rules */

  app.get("/rules", { preHandler: read }, async (request) => {
    const query = rulesQuery.parse(request.query);
    return db
      .selectFrom("pay_rules")
      .selectAll()
      .where("centre_id", "=", request.user!.centreId)
      .$if(query.instructorId !== undefined, (qb) => qb.where("instructor_id", "=", query.instructorId!))
      .orderBy("instructor_id")
      .orderBy("valid_from", "desc")
      .execute();
  });

  /** Rules are never edited: a change is a new rule, so past pay lines keep the rule they were computed with. */
  app.post("/rules", { preHandler: app.requirePermission("payroll:rules") }, async (request, reply) => {
    const actor = request.user!;
    const body = ruleBody.parse(request.body);
    const instructor = await db
      .selectFrom("instructors")
      .select("id")
      .where("id", "=", body.instructorId)
      .where("centre_id", "=", actor.centreId)
      .executeTakeFirst();
    if (!instructor) throw notFound("instructor");
    if (body.scopeId) {
      const table = body.scope === "study" ? "studies" : body.scope === "training" ? "trainings" : "groups";
      const target = await db.selectFrom(table).select("id").where("id", "=", body.scopeId).where("centre_id", "=", actor.centreId).executeTakeFirst();
      if (!target) throw notFound(body.scope);
    }
    if (body.baseKind === "training_flat" && body.scope === "study") throw unprocessable("invalid_base", "a training flat fee cannot apply to a private study");
    const rule = await db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto("pay_rules")
        .values({
          centre_id: actor.centreId,
          instructor_id: body.instructorId,
          scope: body.scope,
          study_id: body.scope === "study" ? body.scopeId! : null,
          training_id: body.scope === "training" ? body.scopeId! : null,
          group_id: body.scope === "group" ? body.scopeId! : null,
          base_kind: body.baseKind,
          basis_points: body.basisPoints ?? null,
          amount: body.amount ?? null,
          collection_basis: body.collectionBasis ?? null,
          presence_kind: body.presenceKind,
          min_rate_basis_points: body.minRateBasisPoints ?? null,
          floor_amount: body.floorAmount ?? null,
          prorata_above: body.prorataAbove ?? null,
          periodicity: body.periodicity ?? PERIODICITIES[body.baseKind][0]!,
          valid_from: body.validFrom,
          valid_to: body.validTo ?? null,
          created_by: actor.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "pay_rule.created",
        objectType: "pay_rule",
        objectId: created.id,
        after: body,
      });
      return created;
    });
    return reply.status(201).send(rule);
  });

  app.post("/rules/:id/archive", { preHandler: app.requirePermission("payroll:rules") }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { reason: why } = z.object({ reason }).strict().parse(request.body);
    return db.transaction().execute(async (trx) => {
      const rule = await trx
        .updateTable("pay_rules")
        .set({ status: "archived" })
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .returningAll()
        .executeTakeFirst();
      if (!rule) throw notFound("pay rule");
      await writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action: "pay_rule.archived", objectType: "pay_rule", objectId: id, reason: why });
      return rule;
    });
  });

  /** What the group's instructor would earn this month so far, from the rule that applies and validated sessions. */
  /** What the rules would pay for a group in a month, without storing anything (group screen). */
  app.get("/estimate", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const q = z.object({ groupId: uuid, month: yearMonth }).parse(request.query);
    const group = await db.selectFrom("groups").select("id").where("id", "=", q.groupId).where("centre_id", "=", centreId).executeTakeFirst();
    if (!group) throw notFound("group");
    const { start, end } = monthBounds(q.month);
    const { candidates, warnings } = await computeCandidates(db, centreId, { from: start, to: end, groupId: q.groupId, excludeValidated: false });
    return {
      lines: candidates.map((c) => ({
        instructorId: c.instructorId,
        label: c.label,
        periodicity: c.rule.periodicity,
        rule: c.rule,
        base: c.base,
        rate: c.rate,
        amount: c.amount,
        dueOn: c.dueOn,
        details: c.details,
      })),
      warnings,
    };
  });

  const itemColumns = [
    "pay_items.id",
    "pay_items.instructor_id as instructorId",
    "pay_items.kind",
    "pay_items.rule_id as ruleId",
    "pay_items.rule_snapshot as rule",
    "pay_items.group_id as groupId",
    "groups.name as groupName",
    "pay_items.period_key as periodKey",
    "pay_items.period_start as periodStart",
    "pay_items.period_end as periodEnd",
    "pay_items.due_on as dueOn",
    "pay_items.label",
    "pay_items.base",
    "pay_items.rate_numerator as rateNumerator",
    "pay_items.rate_denominator as rateDenominator",
    "pay_items.amount",
    "pay_items.details",
    "pay_items.status",
    "pay_items.reason",
    "pay_items.calculated_at as calculatedAt",
    "pay_items.validated_at as validatedAt",
    "pay_items.cancelled_at as cancelledAt",
    "pay_items.cancel_reason as cancelReason",
  ] as const;

  /** Adds what each item has been paid and what is left. */
  const withSettlement = async <T extends { id: string; amount: number; status: string }>(items: T[]) => {
    const settled = await settledAmounts(
      db as never,
      items.map((i) => i.id),
    );
    return items.map((i) => {
      const paid = settled.get(i.id) ?? 0;
      return { ...i, paid, remaining: i.status === "validated" ? i.amount - paid : 0 };
    });
  };

  /**
   * Monthly overview: per instructor, what the month's items amount to at each stage, plus everything validated
   * and still unpaid whatever its month. It is a follow-up view only: nothing is validated for the month as a whole.
   */
  app.get("/summary", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const { month } = monthQuery.parse(request.query);
    const { start, end } = monthBounds(month);
    const instructors = await db
      .selectFrom("instructors")
      .select(["id", "first_name as firstName", "last_name as lastName", "employment", "status"])
      .where("centre_id", "=", centreId)
      .orderBy("last_name")
      .orderBy("first_name")
      .execute();
    const items = await withSettlement(
      await db
        .selectFrom("pay_items")
        .select(["id", "instructor_id as instructorId", "amount", "status", "period_end as periodEnd"])
        .where("centre_id", "=", centreId)
        .where("status", "<>", "cancelled")
        .where((eb) => eb.or([eb.and([eb("period_end", ">=", start), eb("period_end", "<=", end)]), eb("status", "=", "validated")]))
        .execute(),
    );
    // Sessions a calculation of this month would pay and that no item covers yet. A training fee is only counted in
    // the month its group ends, so its sessions do not show as waiting before then.
    const { candidates, warnings } = await computeCandidates(db, centreId, { from: start, to: end, excludeValidated: true });
    const candidateSessions = new Map(candidates.flatMap((c) => c.sessionIds.map((sessionId) => [sessionId, c.instructorId] as const)));
    const covered = candidateSessions.size
      ? await db
          .selectFrom("pay_item_sessions")
          .select(["session_id as sessionId", "instructor_id as instructorId"])
          .where("active", "=", true)
          .where("session_id", "in", [...candidateSessions.keys()])
          .execute()
      : [];
    const coveredKeys = new Set(covered.map((c) => `${c.sessionId}|${c.instructorId}`));
    const uncovered = new Map<string, number>();
    for (const [sessionId, instructorId] of candidateSessions) {
      if (!coveredKeys.has(`${sessionId}|${instructorId}`)) uncovered.set(instructorId, (uncovered.get(instructorId) ?? 0) + 1);
    }
    const rows = instructors
      .map((i) => {
        const own = items.filter((it) => it.instructorId === i.id);
        const inMonth = own.filter((it) => it.periodEnd >= start && it.periodEnd <= end);
        const sum = (list: typeof own, pick: (it: (typeof own)[number]) => number) => list.reduce((s, it) => s + pick(it), 0);
        return {
          ...i,
          calculated: sum(
            inMonth.filter((it) => it.status === "calculated"),
            (it) => it.amount,
          ),
          validated: sum(
            inMonth.filter((it) => it.status === "validated"),
            (it) => it.amount,
          ),
          paid: sum(inMonth, (it) => it.paid),
          remaining: sum(inMonth, (it) => it.remaining),
          outstanding: sum(own, (it) => it.remaining),
          toValidate: inMonth.filter((it) => it.status === "calculated").length,
          sessionsToCalculate: uncovered.get(i.id) ?? 0,
          groupsWithoutRule: warnings.filter((w) => w.instructorId === i.id && w.code === "no_rule").length,
        };
      })
      .filter((r) => r.status === "active" || r.calculated || r.validated || r.outstanding || r.sessionsToCalculate || r.groupsWithoutRule);
    const total = (key: "calculated" | "validated" | "paid" | "remaining" | "outstanding") => rows.reduce((s, r) => s + r[key], 0);
    return {
      month,
      instructors: rows,
      totals: {
        calculated: total("calculated"),
        validated: total("validated"),
        paid: total("paid"),
        remaining: total("remaining"),
        outstanding: total("outstanding"),
      },
    };
  });

  /** One instructor's pay for a month: items by status, items of earlier months still unpaid, settlements, rules. */
  app.get("/instructors/:id", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const { id } = idParam.parse(request.params);
    const { month } = monthQuery.parse(request.query);
    const { start, end } = monthBounds(month);
    const instructor = await db
      .selectFrom("instructors")
      .select(["id", "first_name as firstName", "last_name as lastName", "employment", "status"])
      .where("id", "=", id)
      .where("centre_id", "=", centreId)
      .executeTakeFirst();
    if (!instructor) throw notFound("instructor");
    const items = await withSettlement(
      await db
        .selectFrom("pay_items")
        .leftJoin("groups", "groups.id", "pay_items.group_id")
        .select(itemColumns)
        .where("pay_items.centre_id", "=", centreId)
        .where("pay_items.instructor_id", "=", id)
        .where((eb) =>
          eb.or([
            eb.and([eb("pay_items.period_end", ">=", start), eb("pay_items.period_end", "<=", end)]),
            eb.and([eb("pay_items.status", "=", "validated"), eb("pay_items.period_end", "<", start)]),
          ]),
        )
        .orderBy("pay_items.period_end")
        .orderBy("pay_items.label")
        .execute(),
    );
    const sessionCounts = items.length
      ? await db
          .selectFrom("pay_item_sessions")
          .select(["item_id as itemId", sql<number>`count(*)::integer`.as("n")])
          .where(
            "item_id",
            "in",
            items.map((i) => i.id),
          )
          .groupBy("item_id")
          .execute()
      : [];
    const settlements = await db
      .selectFrom("pay_settlements")
      .select(["id", "number", "paid_on as paidOn", "method", "reference", "amount", "status", "cancel_reason as cancelReason", "created_at as createdAt"])
      .where("centre_id", "=", centreId)
      .where("instructor_id", "=", id)
      .orderBy("paid_on", "desc")
      .orderBy("created_at", "desc")
      .limit(100)
      .execute();
    const rules = await db
      .selectFrom("pay_rules")
      .selectAll()
      .where("centre_id", "=", centreId)
      .where("instructor_id", "=", id)
      .where("status", "=", "active")
      .where("valid_from", "<=", end)
      .where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">=", start)]))
      .execute();
    const { today } = await centreClock(db, centreId);
    return {
      instructor,
      month,
      today,
      items: items.map((i) => ({ ...i, sessions: Number(sessionCounts.find((c) => c.itemId === i.id)?.n ?? 0), earlierMonth: i.periodEnd < start })),
      settlements,
      rules,
    };
  });

  /** Sessions of an item and its history (calculation, validation, settlements, correction). */
  app.get("/items/:id", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const { id } = idParam.parse(request.params);
    const item = await db
      .selectFrom("pay_items")
      .leftJoin("groups", "groups.id", "pay_items.group_id")
      .select(itemColumns)
      .where("pay_items.id", "=", id)
      .where("pay_items.centre_id", "=", centreId)
      .executeTakeFirst();
    if (!item) throw notFound("pay item");
    const { timezone } = await centreClock(db, centreId);
    const sessions = await db
      .selectFrom("pay_item_sessions")
      .innerJoin("class_sessions", "class_sessions.id", "pay_item_sessions.session_id")
      .innerJoin("groups", "groups.id", "class_sessions.group_id")
      .select([
        "class_sessions.id",
        "groups.name as groupName",
        "class_sessions.starts_at as startsAt",
        "class_sessions.ends_at as endsAt",
        sql<string>`to_char(class_sessions.starts_at at time zone ${timezone}, 'YYYY-MM-DD')`.as("localDate"),
        "pay_item_sessions.active",
      ])
      .where("pay_item_sessions.item_id", "=", id)
      .orderBy("class_sessions.starts_at")
      .execute();
    const settlements = await db
      .selectFrom("pay_settlement_lines")
      .innerJoin("pay_settlements", "pay_settlements.id", "pay_settlement_lines.settlement_id")
      .select(["pay_settlements.id", "pay_settlements.number", "pay_settlements.paid_on as paidOn", "pay_settlements.status", "pay_settlement_lines.amount"])
      .where("pay_settlement_lines.item_id", "=", id)
      .orderBy("pay_settlements.paid_on")
      .execute();
    const [withPaid] = await withSettlement([item]);
    return { ...withPaid, sessions, settlements };
  });

  /** "Calculer": an instructor's items for a month (sessions held, the month itself, groups ending in it). */
  app.post("/calculate", { preHandler: calculate }, async (request) => {
    const actor = request.user!;
    const body = calculateBody.parse(request.body);
    const { start, end } = monthBounds(body.month);
    return db.transaction().execute((trx) => calculateItems(trx, actor, body.instructorId, { from: start, to: end }));
  });

  /** "Valider": selected items, each from its due date; other items and instructors are not affected. */
  app.post("/items/validate", { preHandler: calculate }, async (request) => {
    const actor = request.user!;
    const { itemIds } = itemIdsBody.parse(request.body);
    const validated = await db.transaction().execute((trx) => validateItems(trx, actor, itemIds));
    return { validated };
  });

  app.post("/items/:id/cancel", { preHandler: calculate }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = cancelBody.parse(request.body);
    await db.transaction().execute((trx) => cancelItem(trx, actor, id, body.reason));
    return { id, status: "cancelled" };
  });

  app.post("/adjustments", { preHandler: calculate }, async (request, reply) => {
    const actor = request.user!;
    const body = adjustmentBody.parse(request.body);
    const id = await db.transaction().execute((trx) => addAdjustment(trx, actor, body));
    return reply.status(201).send({ id });
  });

  /** "Régler": one payment covering one or more validated items, in full or in part. */
  app.post("/settlements", { preHandler: calculate }, async (request, reply) => {
    const actor = request.user!;
    const body = settlementBody.parse(request.body);
    const result = await db.transaction().execute((trx) => settleItems(trx, actor, body));
    return reply.status(201).send(result);
  });

  app.post("/settlements/:id/cancel", { preHandler: calculate }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = cancelBody.parse(request.body);
    await db.transaction().execute((trx) => cancelSettlement(trx, actor, id, body.reason));
    return { id, status: "cancelled" };
  });

  app.get("/settlements/:id/pdf", { preHandler: read }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const settlement = await db
      .selectFrom("pay_settlements")
      .select(["pdf", "number"])
      .where("id", "=", id)
      .where("centre_id", "=", request.user!.centreId)
      .executeTakeFirst();
    if (!settlement) throw notFound("settlement");
    return reply.header("content-type", "application/pdf").header("content-disposition", `inline; filename="${settlement.number}.pdf"`).send(settlement.pdf);
  });
};
