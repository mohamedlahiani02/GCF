import { createHash } from "node:crypto";
import { formatTnd } from "@gcf/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { Database } from "../db/types.js";
import { recordFinancialEvents } from "../domain/financialEvents.js";
import { computeMonth } from "../domain/payrollCalc.js";
import { renderPayslip } from "../domain/payslipPdf.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { basisPoints, idParam, isoDate, millimes, reason, uuid } from "../validation.js";

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
    if ((r.presenceKind === "threshold") !== (r.minRateBasisPoints !== undefined && r.prorataAbove !== undefined)) issue("a threshold needs minRateBasisPoints and prorataAbove");
    if (r.presenceKind !== "threshold" && r.floorAmount !== undefined) issue("a floor only applies to a threshold");
    if (r.validTo && r.validTo < r.validFrom) issue("validTo cannot be before validFrom");
  });
const periodBody = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "expected YYYY-MM") }).strict();
const adjustmentBody = z.object({ instructorId: uuid, kind: z.enum(["bonus", "deduction"]), amount: millimes.min(1), reason }).strict();
const payBody = z.object({ paidOn: isoDate, method: z.enum(["cash", "transfer", "cheque"]), reference: z.string().trim().max(100).optional() }).strict();
const payslipParams = z.object({ id: uuid, instructorId: uuid });
const rulesQuery = z.object({ instructorId: uuid.optional() });

const MONTHS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const periodLabel = (month: string) => `${MONTHS_FR[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
const EMPLOYMENT_FR = { salaried: "salarié", freelance: "freelance", contractor: "vacataire" } as const;
const BASE_FR = {
  pct_collections: "% des encaissements",
  pct_session_tariff: "% du tarif de séance",
  fixed_per_session: "montant fixe par séance",
  monthly_flat: "forfait mensuel",
  hourly: "taux horaire",
  training_flat: "forfait de formation",
} as const;
const PRESENCE_FR = { ignore: "présence ignorée", prorata: "au prorata de la présence", session_due: "séance due", threshold: "seuil minimum" } as const;
const NARROW_NBSP = String.fromCharCode(0x202f);
const tnd = (amount: number) => formatTnd(amount, "fr").split(NARROW_NBSP).join(" ");

async function loadPeriod(trx: Transaction<Database>, id: string, centreId: string) {
  const period = await trx.selectFrom("pay_periods").selectAll().where("id", "=", id).where("centre_id", "=", centreId).forUpdate().executeTakeFirst();
  if (!period) throw notFound("pay period");
  return period;
}

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
    const instructor = await db.selectFrom("instructors").select("id").where("id", "=", body.instructorId).where("centre_id", "=", actor.centreId).executeTakeFirst();
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
          valid_from: body.validFrom,
          valid_to: body.validTo ?? null,
          created_by: actor.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action: "pay_rule.created", objectType: "pay_rule", objectId: created.id, after: body });
      return created;
    });
    return reply.status(201).send(rule);
  });

  app.post("/rules/:id/archive", { preHandler: app.requirePermission("payroll:rules") }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { reason: why } = z.object({ reason }).strict().parse(request.body);
    return db.transaction().execute(async (trx) => {
      const rule = await trx.updateTable("pay_rules").set({ status: "archived" }).where("id", "=", id).where("centre_id", "=", actor.centreId).returningAll().executeTakeFirst();
      if (!rule) throw notFound("pay rule");
      await writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action: "pay_rule.archived", objectType: "pay_rule", objectId: id, reason: why });
      return rule;
    });
  });

  /* Periods */

  app.get("/periods", { preHandler: read }, async (request) => {
    const rows = await db
      .selectFrom("pay_periods")
      .leftJoin("pay_lines", "pay_lines.period_id", "pay_periods.id")
      .select(["pay_periods.id", "pay_periods.month", "pay_periods.status"])
      .select((eb) => [eb.fn.count<number>("pay_lines.instructor_id").distinct().as("instructors"), sql<number>`coalesce(sum(pay_lines.amount), 0)::bigint`.as("linesTotal")])
      .where("pay_periods.centre_id", "=", request.user!.centreId)
      .groupBy("pay_periods.id")
      .orderBy("pay_periods.month", "desc")
      .execute();
    const adjustments = await db
      .selectFrom("pay_adjustments")
      .innerJoin("pay_periods", "pay_periods.id", "pay_adjustments.period_id")
      .select(["pay_adjustments.period_id as periodId", sql<number>`sum(case when kind = 'bonus' then amount else -amount end)::bigint`.as("net")])
      .where("pay_periods.centre_id", "=", request.user!.centreId)
      .groupBy("pay_adjustments.period_id")
      .execute();
    const net = new Map(adjustments.map((a) => [a.periodId, Number(a.net)]));
    return rows.map((r) => ({ id: r.id, month: r.month, label: periodLabel(r.month), status: r.status, instructors: Number(r.instructors), total: Number(r.linesTotal) + (net.get(r.id) ?? 0) }));
  });

  app.post("/periods", { preHandler: calculate }, async (request, reply) => {
    const actor = request.user!;
    const { month } = periodBody.parse(request.body);
    const period = await db.transaction().execute(async (trx) => {
      const created = await trx.insertInto("pay_periods").values({ centre_id: actor.centreId, month: `${month}-01` }).returning(["id", "month", "status"]).executeTakeFirstOrThrow();
      await writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action: "pay_period.created", objectType: "pay_period", objectId: created.id, after: { month } });
      return created;
    });
    return reply.status(201).send({ ...period, label: periodLabel(period.month) });
  });

  const periodDetail = async (id: string, centreId: string) => {
    const period = await db.selectFrom("pay_periods").selectAll().where("id", "=", id).where("centre_id", "=", centreId).executeTakeFirst();
    if (!period) throw notFound("pay period");
    const lines = await db
      .selectFrom("pay_lines")
      .leftJoin("groups", "groups.id", "pay_lines.group_id")
      .select(["pay_lines.id", "pay_lines.instructor_id as instructorId", "pay_lines.group_id as groupId", "groups.name as groupName", "pay_lines.rule_snapshot as rule", "pay_lines.base", "pay_lines.rate_numerator as rateNumerator", "pay_lines.rate_denominator as rateDenominator", "pay_lines.amount", "pay_lines.details"])
      .where("period_id", "=", id)
      .execute();
    const adjustments = await db.selectFrom("pay_adjustments").select(["id", "instructor_id as instructorId", "kind", "amount", "reason", "created_at as createdAt"]).where("period_id", "=", id).orderBy("created_at").execute();
    const payslips = await db.selectFrom("payslips").select(["instructor_id as instructorId", "total", "issued_at as issuedAt", "paid_on as paidOn", "payment_method as paymentMethod", "payment_reference as paymentReference"]).where("period_id", "=", id).execute();
    const instructorIds = [...new Set([...lines.map((l) => l.instructorId), ...adjustments.map((a) => a.instructorId)])];
    const instructors = instructorIds.length
      ? await db.selectFrom("instructors").select(["id", "first_name as firstName", "last_name as lastName", "employment"]).where("id", "in", instructorIds).execute()
      : [];
    const summary = instructors
      .map((i) => {
        const own = lines.filter((l) => l.instructorId === i.id);
        const adj = adjustments.filter((a) => a.instructorId === i.id);
        const calculated = own.reduce((s, l) => s + l.amount, 0);
        const adjustmentsNet = adj.reduce((s, a) => s + (a.kind === "bonus" ? a.amount : -a.amount), 0);
        const slip = payslips.find((p) => p.instructorId === i.id) ?? null;
        return { ...i, calculated, adjustments: adjustmentsNet, net: calculated + adjustmentsNet, lines: own, adjustmentLines: adj, payslip: slip };
      })
      .sort((a, b) => a.lastName.localeCompare(b.lastName, "fr"));
    return { id: period.id, month: period.month, label: periodLabel(period.month), status: period.status, calculatedAt: period.calculated_at, validatedAt: period.validated_at, instructors: summary, total: summary.reduce((s, i) => s + i.net, 0) };
  };

  app.get("/periods/:id", { preHandler: read }, async (request) => {
    const { id } = idParam.parse(request.params);
    return periodDetail(id, request.user!.centreId);
  });

  /** (Re)computes the lines from validated sessions. Adjustments are kept. */
  app.post("/periods/:id/calculate", { preHandler: calculate }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const warnings = await db.transaction().execute(async (trx) => {
      const period = await loadPeriod(trx, id, actor.centreId);
      if (period.status === "validated" || period.status === "paid") throw conflict("period_locked", "a validated period cannot be recalculated");
      const { lines, warnings: found } = await computeMonth(trx, actor.centreId, period.month);
      await trx.deleteFrom("pay_lines").where("period_id", "=", id).execute();
      if (lines.length) {
        await trx
          .insertInto("pay_lines")
          .values(lines.map((l) => ({ period_id: id, instructor_id: l.instructorId, group_id: l.groupId, rule_id: l.rule.id, rule_snapshot: JSON.stringify(l.rule), base: l.base, rate_numerator: l.rate.numerator, rate_denominator: l.rate.denominator, amount: l.amount, details: JSON.stringify(l.details) })))
          .execute();
      }
      await trx.updateTable("pay_periods").set({ status: "calculated", calculated_at: new Date() }).where("id", "=", id).execute();
      await writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action: "pay_period.calculated", objectType: "pay_period", objectId: id, after: { lines: lines.length, total: lines.reduce((s, l) => s + l.amount, 0), warnings: found.length } });
      return found;
    });
    return { ...(await periodDetail(id, actor.centreId)), warnings };
  });

  app.post("/periods/:id/adjustments", { preHandler: calculate }, async (request, reply) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = adjustmentBody.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const period = await loadPeriod(trx, id, actor.centreId);
      if (period.status === "validated" || period.status === "paid") throw conflict("period_locked", "a validated period cannot change");
      const instructor = await trx.selectFrom("instructors").select("id").where("id", "=", body.instructorId).where("centre_id", "=", actor.centreId).executeTakeFirst();
      if (!instructor) throw notFound("instructor");
      const created = await trx.insertInto("pay_adjustments").values({ period_id: id, instructor_id: body.instructorId, kind: body.kind, amount: body.amount, reason: body.reason, created_by: actor.userId }).returning("id").executeTakeFirstOrThrow();
      await writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action: `pay_adjustment.${body.kind}`, objectType: "pay_period", objectId: id, after: { ...body, id: created.id }, reason: body.reason });
    });
    return reply.status(201).send(await periodDetail(id, actor.centreId));
  });

  /** Freezes the period: pay lines keep their copied rule, payslips are issued and the journal is written. */
  app.post("/periods/:id/validate", { preHandler: calculate }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    await db.transaction().execute(async (trx) => {
      const period = await loadPeriod(trx, id, actor.centreId);
      if (period.status !== "calculated") throw conflict("not_calculated", "calculate the period before validating it");
      const detail = await periodDetail(id, actor.centreId);
      const centre = await trx.selectFrom("centres").select(["name", "address", "timezone"]).where("id", "=", actor.centreId).executeTakeFirstOrThrow();
      const issued = await sql<{ at: string }>`select to_char(now() at time zone ${centre.timezone}, 'DD/MM/YYYY') as at`.execute(trx);
      const groupAxes = await trx.selectFrom("groups").leftJoin("training_sessions", "training_sessions.id", "groups.training_session_id").select(["groups.id", "groups.study_id as studyId", "training_sessions.training_id as trainingId"]).execute();
      const axesOf = new Map(groupAxes.map((g) => [g.id, g]));
      for (const instructor of detail.instructors) {
        const pdf = await renderPayslip({
          centreName: centre.name,
          centreAddress: centre.address,
          instructorName: `${instructor.firstName} ${instructor.lastName}`,
          employment: EMPLOYMENT_FR[instructor.employment],
          periodLabel: detail.label,
          lines: instructor.lines.map((l) => {
            const rule = l.rule as { base_kind: keyof typeof BASE_FR; presence_kind: keyof typeof PRESENCE_FR };
            const details = l.details as { sessions: number; minutes: number; collected: number; rateBasisPoints: number | null };
            const rate = details.rateBasisPoints === null ? "taux non calculé" : `présence ${(details.rateBasisPoints / 100).toFixed(2).replace(".", ",")} %`;
            return {
              label: l.groupName ?? "Forfait mensuel",
              detail: `${BASE_FR[rule.base_kind]}, ${PRESENCE_FR[rule.presence_kind]} ; ${details.sessions} séance(s), base ${tnd(l.base)} TND, ${rate}`,
              amount: l.amount,
            };
          }),
          adjustments: instructor.adjustmentLines.map((a) => ({ label: `${a.kind === "bonus" ? "Prime" : "Retenue"} : ${a.reason}`, amount: a.kind === "bonus" ? a.amount : -a.amount })),
          total: instructor.net,
          issuedAt: issued.rows[0]!.at,
        });
        await trx.insertInto("payslips").values({ period_id: id, instructor_id: instructor.id, total: instructor.net, pdf, sha256: createHash("sha256").update(pdf).digest("hex") }).execute();
        await recordFinancialEvents(trx, [
          ...instructor.lines.map((l) => ({ centreId: actor.centreId, type: "payroll_validated" as const, amount: l.amount, userId: actor.userId, instructorId: instructor.id, groupId: l.groupId, studyId: l.groupId ? (axesOf.get(l.groupId)?.studyId ?? null) : null, trainingId: l.groupId ? (axesOf.get(l.groupId)?.trainingId ?? null) : null, payload: { periodId: id, lineId: l.id } })),
          ...instructor.adjustmentLines.map((a) => ({ centreId: actor.centreId, type: "payroll_validated" as const, amount: a.kind === "bonus" ? a.amount : -a.amount, userId: actor.userId, instructorId: instructor.id, payload: { periodId: id, adjustmentId: a.id, reason: a.reason } })),
        ]);
      }
      await trx.updateTable("pay_periods").set({ status: "validated", validated_at: new Date(), validated_by: actor.userId }).where("id", "=", id).execute();
      await writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action: "pay_period.validated", objectType: "pay_period", objectId: id, after: { total: detail.total } });
    });
    return periodDetail(id, actor.centreId);
  });

  app.post("/periods/:id/payslips/:instructorId/pay", { preHandler: calculate }, async (request) => {
    const actor = request.user!;
    const { id, instructorId } = payslipParams.parse(request.params);
    const body = payBody.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const period = await loadPeriod(trx, id, actor.centreId);
      if (period.status !== "validated") throw conflict("not_validated", "only a validated period can be paid");
      const slip = await trx.selectFrom("payslips").select(["id", "total", "paid_on"]).where("period_id", "=", id).where("instructor_id", "=", instructorId).forUpdate().executeTakeFirst();
      if (!slip) throw notFound("payslip");
      if (slip.paid_on) throw conflict("already_paid", "this payslip is already paid");
      await trx.updateTable("payslips").set({ paid_on: body.paidOn, payment_method: body.method, payment_reference: body.reference ?? null, paid_by: actor.userId }).where("id", "=", slip.id).execute();
      await recordFinancialEvents(trx, [{ centreId: actor.centreId, type: "payroll_paid", amount: slip.total, userId: actor.userId, instructorId, payload: { periodId: id, method: body.method, paidOn: body.paidOn } }]);
      const unpaid = await trx.selectFrom("payslips").select("id").where("period_id", "=", id).where("paid_on", "is", null).executeTakeFirst();
      if (!unpaid) await trx.updateTable("pay_periods").set({ status: "paid" }).where("id", "=", id).execute();
      await writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action: "payslip.paid", objectType: "pay_period", objectId: id, after: { instructorId, ...body } });
    });
    return periodDetail(id, actor.centreId);
  });

  app.get("/periods/:id/payslips/:instructorId/pdf", { preHandler: read }, async (request, reply) => {
    const { id, instructorId } = payslipParams.parse(request.params);
    const slip = await db
      .selectFrom("payslips")
      .innerJoin("pay_periods", "pay_periods.id", "payslips.period_id")
      .select(["payslips.pdf", "pay_periods.month"])
      .where("payslips.period_id", "=", id)
      .where("payslips.instructor_id", "=", instructorId)
      .where("pay_periods.centre_id", "=", request.user!.centreId)
      .executeTakeFirst();
    if (!slip) throw notFound("payslip");
    return reply.header("content-type", "application/pdf").header("content-disposition", `inline; filename="paie-${slip.month.slice(0, 7)}.pdf"`).send(slip.pdf);
  });
};
