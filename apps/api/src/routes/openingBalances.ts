import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { recordFinancialEvents } from "../domain/financialEvents.js";
import { centreClock, lockPayer, settlePayer, type Payer } from "../domain/ledger.js";
import { unprocessable } from "../errors.js";
import { isoDate, millimes, optionalText, requiredText, uuid } from "../validation.js";
import { advanceBody, recordPayment } from "./payments.js";

const payerSchema = z.object({ kind: z.enum(["student", "member"]), id: uuid }).strict();

export const debtBody = z
  .object({
    payer: payerSchema,
    label: requiredText(150).default("Solde d'ouverture"),
    amount: millimes.min(1),
    /** The date the debt was due in the previous system; it decides how old the debt looks and how it is paid. */
    dueDate: isoDate,
    note: optionalText(500),
  })
  .strict();

export { advanceBody };

const MODULE_OF = { student: "training", member: "coworking" } as const;

/**
 * Opening balances: what a student or a coworking member owed or had paid in advance when the centre moved to the
 * application. A debt is a charge that is not new revenue (the reports leave it out of "invoiced" and the payroll
 * bases never read it); an advance is an ordinary payment received on the switch-over day, with its receipt.
 * Both settle against the payer's other charges and credit like any other money movement.
 */
export const openingBalanceRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const write = app.requirePermission("opening:write");

  app.post("/debts", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const body = debtBody.parse(request.body);
    if (!actor.modules.includes(MODULE_OF[body.payer.kind]))
      throw unprocessable("module_not_enabled", `the ${MODULE_OF[body.payer.kind]} module is not enabled`);
    const payer: Payer = body.payer;
    const created = await db.transaction().execute(async (trx) => {
      await lockPayer(trx, payer, actor.centreId);
      const { today } = await centreClock(trx, actor.centreId);
      if (body.dueDate >= today) throw unprocessable("not_in_the_past", "an opening debt is dated before today: it was already due in the previous system");
      const row = await trx
        .insertInto("installments")
        .values({
          centre_id: actor.centreId,
          label: body.label,
          kind: "charge",
          amount: body.amount,
          due_date: body.dueDate,
          original_due_date: body.dueDate,
          opening_balance: true,
          student_id: payer.kind === "student" ? payer.id : null,
          member_id: payer.kind === "member" ? payer.id : null,
          created_by: actor.userId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await recordFinancialEvents(trx, [
        {
          centreId: actor.centreId,
          type: "installment_issued",
          amount: body.amount,
          userId: actor.userId,
          studentId: payer.kind === "student" ? payer.id : null,
          memberId: payer.kind === "member" ? payer.id : null,
          installmentId: row.id,
          payload: { openingBalance: true },
        },
      ]);
      // Credit the payer already holds pays the debt straight away, as for any new charge.
      await settlePayer(trx, actor.centreId, payer, actor.userId);
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "opening_balance.debt_created",
        objectType: "installment",
        objectId: row.id,
        after: { payer, label: body.label, amount: body.amount, dueDate: body.dueDate, note: body.note ?? null },
      });
      return row;
    });
    return reply.status(201).send({ id: created.id });
  });

  app.post("/advances", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const body = advanceBody.parse(request.body);
    const kind = body.payer.kind;
    if (!actor.modules.includes(MODULE_OF[kind])) throw unprocessable("module_not_enabled", `the ${MODULE_OF[kind]} module is not enabled`);
    const result = await recordPayment(db, actor, {
      ...(kind === "student" ? { studentId: body.payer.id } : { memberId: body.payer.id }),
      amount: body.amount,
      method: body.method,
      ...(body.cheque ? { cheque: body.cheque } : {}),
      reference: body.reference,
      note: body.note ?? `Avance reprise : ${body.reference}`,
      installmentIds: [],
    });
    return reply.status(201).send(result);
  });
};
