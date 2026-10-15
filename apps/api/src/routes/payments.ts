import type { FastifyPluginAsync } from "fastify";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { Database } from "../db/types.js";
import { assertCashOpen } from "../domain/cash.js";
import { recordFinancialEvents } from "../domain/financialEvents.js";
import { applyAllocations, lockPayer, payerCredit, payerTotals, planAllocations, settlePayer, type Payer, type PlannedAllocation } from "../domain/ledger.js";
import { issueReceipt } from "../domain/receipts.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { idParam, isoDate, millimes, optionalText, reason, uuid } from "../validation.js";

const cheque = z.object({ number: z.string().trim().min(1).max(40), bank: z.string().trim().min(1).max(100) }).strict();
const payerFields = { studentId: uuid.optional(), renterId: uuid.optional() };
const onePayer = (p: { studentId?: string | undefined; renterId?: string | undefined }) => !!p.studentId !== !!p.renterId;
const payerOf = (p: { studentId?: string | undefined; renterId?: string | undefined }): Payer =>
  p.studentId ? { kind: "student", id: p.studentId } : { kind: "renter", id: p.renterId! };
const payerOfRow = (row: { student_id: string | null; renter_id: string | null }): Payer =>
  row.student_id ? { kind: "student", id: row.student_id } : { kind: "renter", id: row.renter_id! };

const paymentBody = z
  .object({
    ...payerFields,
    amount: millimes.min(1),
    method: z.enum(["cash", "transfer", "cheque", "card"]),
    cheque: cheque.optional(),
    reference: optionalText(100),
    note: optionalText(500),
    installmentIds: z.array(uuid).max(200).default([]),
  })
  .strict()
  .refine(onePayer, "give either studentId or renterId")
  .refine((p) => (p.method === "cheque") === !!p.cheque, "a cheque needs its number and bank, other methods none");
const previewBody = z
  .object({ ...payerFields, amount: millimes.min(1), installmentIds: z.array(uuid).max(200).default([]) })
  .strict()
  .refine(onePayer, "give either studentId or renterId");
const refundBody = z
  .object({ ...payerFields, amount: millimes.min(1), method: z.enum(["cash", "transfer", "cheque", "card"]), cheque: cheque.optional(), reason })
  .strict()
  .refine(onePayer, "give either studentId or renterId");
const chequeStatusBody = z.object({ status: z.enum(["deposited", "cashed", "bounced"]), reason: reason.optional() }).strict();
const cancelBody = z.object({ reason }).strict();
const listQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  method: z.enum(["cash", "transfer", "cheque", "card"]).optional(),
  userId: uuid.optional(),
  studentId: uuid.optional(),
  renterId: uuid.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const CHEQUE_FLOW: Record<string, string[]> = {
  received: ["deposited", "cashed", "bounced"],
  deposited: ["cashed", "bounced"],
  cashed: ["bounced"],
  bounced: [],
};

function summarise(planned: PlannedAllocation[]) {
  const lines = new Map<string, { installmentId: string; label: string; dueDate: string; amount: number }>();
  for (const p of planned.filter((x) => x.source === "payment")) {
    const line = lines.get(p.installmentId) ?? { installmentId: p.installmentId, label: p.label, dueDate: p.dueDate, amount: 0 };
    line.amount += p.amount;
    lines.set(p.installmentId, line);
  }
  return [...lines.values()];
}

/** Axes of the instalments a payment touched, for the financial journal. */
async function allocationAxes(trx: Transaction<Database>, paymentId: string) {
  return trx
    .selectFrom("allocations")
    .innerJoin("installments", "installments.id", "allocations.installment_id")
    .leftJoin("enrolments", "enrolments.id", "installments.enrolment_id")
    .leftJoin("groups", "groups.id", "enrolments.group_id")
    .leftJoin("training_sessions", "training_sessions.id", "groups.training_session_id")
    .leftJoin("rentals", "rentals.id", "installments.rental_id")
    .select([
      "allocations.amount",
      "installments.id as installmentId",
      "installments.rental_id as rentalId",
      "rentals.room_id as roomId",
      "enrolments.id as enrolmentId",
      "groups.id as groupId",
      "groups.study_id as studyId",
      "training_sessions.training_id as trainingId",
      "groups.instructor_id as instructorId",
    ])
    .where("allocations.payment_id", "=", paymentId)
    .execute();
}

export const paymentRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const read = app.requirePermission("payments:read");
  const write = app.requirePermission("payments:write");

  const assertInstallmentsOfPayer = async (payer: Payer, installmentIds: string[], centreId: string) => {
    if (installmentIds.length === 0) return;
    const rows = await db
      .selectFrom("installments")
      .leftJoin("enrolments", "enrolments.id", "installments.enrolment_id")
      .leftJoin("rentals", "rentals.id", "installments.rental_id")
      .select("installments.id")
      .where("installments.id", "in", installmentIds)
      .where(payer.kind === "student" ? "enrolments.student_id" : "rentals.renter_id", "=", payer.id)
      .where("installments.centre_id", "=", centreId)
      .where("installments.kind", "=", "charge")
      .where("installments.status", "=", "open")
      .execute();
    if (rows.length !== new Set(installmentIds).size) throw unprocessable("unknown_installment", "a selected instalment is not an open charge of this payer");
  };

  /** What the payment would pay, and what would remain as credit, before anything is saved. */
  app.post("/preview", { preHandler: write }, async (request) => {
    const centreId = request.user!.centreId;
    const body = previewBody.parse(request.body);
    const payer = payerOf(body);
    await assertInstallmentsOfPayer(payer, body.installmentIds, centreId);
    const totals = await payerTotals(db, centreId, payer);
    const planned = await planAllocations(db, centreId, payer, { priority: body.installmentIds, extraCredit: body.amount, pendingPaymentId: "pending" });
    const lines = summarise(planned.filter((p) => p.sourceId === "pending"));
    const allocated = lines.reduce((s, l) => s + l.amount, 0);
    return {
      before: totals,
      lines,
      advance: body.amount - allocated,
      after: {
        due: totals.due - planned.filter((p) => p.source === "payment").reduce((s, p) => s + p.amount, 0),
        credit: totals.credit + body.amount - planned.filter((p) => p.source === "payment").reduce((s, p) => s + p.amount, 0),
      },
    };
  });

  app.post("/", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const body = paymentBody.parse(request.body);
    const payer = payerOf(body);
    await assertInstallmentsOfPayer(payer, body.installmentIds, actor.centreId);
    const result = await db.transaction().execute(async (trx) => {
      await assertCashOpen(trx, actor.centreId);
      await lockPayer(trx, payer, actor.centreId);
      const payment = await trx
        .insertInto("payments")
        .values({
          centre_id: actor.centreId,
          student_id: body.studentId ?? null,
          renter_id: body.renterId ?? null,
          amount: body.amount,
          method: body.method,
          cheque_number: body.cheque?.number ?? null,
          cheque_bank: body.cheque?.bank ?? null,
          cheque_status: body.method === "cheque" ? "received" : null,
          reference: body.reference ?? null,
          note: body.note ?? null,
          created_by: actor.userId,
        })
        .returning(["id", "received_at as receivedAt"])
        .executeTakeFirstOrThrow();
      const planned = await planAllocations(trx, actor.centreId, payer, { priority: body.installmentIds });
      await applyAllocations(trx, actor.centreId, planned, actor.userId);
      const ownLines = summarise(planned.filter((p) => p.sourceId === payment.id));
      const axes = await allocationAxes(trx, payment.id);
      const allocated = axes.reduce((s, a) => s + a.amount, 0);
      await recordFinancialEvents(trx, [
        ...axes.map((a) => ({
          centreId: actor.centreId,
          type: "payment_received" as const,
          amount: a.amount,
          userId: actor.userId,
          studentId: body.studentId ?? null,
          renterId: body.renterId ?? null,
          rentalId: a.rentalId,
          roomId: a.roomId,
          installmentId: a.installmentId,
          enrolmentId: a.enrolmentId,
          groupId: a.groupId,
          studyId: a.studyId,
          trainingId: a.trainingId,
          instructorId: a.instructorId,
          payload: { paymentId: payment.id, method: body.method },
        })),
        ...(body.amount - allocated > 0
          ? [
              {
                centreId: actor.centreId,
                type: "payment_received" as const,
                amount: body.amount - allocated,
                userId: actor.userId,
                studentId: body.studentId ?? null,
                renterId: body.renterId ?? null,
                payload: { paymentId: payment.id, method: body.method, advance: true },
              },
            ]
          : []),
      ]);
      const receipt = await issueReceipt(trx, {
        centreId: actor.centreId,
        paymentId: payment.id,
        kind: "payment",
        lines: ownLines.map((l) => ({ label: l.label, amount: l.amount })),
        userId: actor.userId,
      });
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "payment.created",
        objectType: "payment",
        objectId: payment.id,
        after: { ...body, receipt: receipt.number, lines: ownLines },
      });
      return { paymentId: payment.id, receipt, lines: ownLines, advance: body.amount - allocated };
    });
    const totals = await payerTotals(db, actor.centreId, payer);
    return reply.status(201).send({ ...result, after: totals });
  });

  app.get("/", { preHandler: read }, async (request) => {
    const query = listQuery.parse(request.query);
    const centreId = request.user!.centreId;
    const centre = await db.selectFrom("centres").select("timezone").where("id", "=", centreId).executeTakeFirstOrThrow();
    const rows = await db
      .selectFrom("payments")
      .leftJoin("students", "students.id", "payments.student_id")
      .leftJoin("renters", "renters.id", "payments.renter_id")
      .leftJoin("users", "users.id", "payments.created_by")
      .leftJoin("receipts", (join) => join.onRef("receipts.payment_id", "=", "payments.id").on("receipts.kind", "!=", "cancellation"))
      .select([
        "payments.id",
        "payments.kind",
        "payments.received_at as receivedAt",
        "payments.student_id as studentId",
        "payments.renter_id as renterId",
        "students.first_name as firstName",
        "students.last_name as lastName",
        "renters.name as renterName",
        "payments.amount",
        "payments.method",
        "payments.cheque_status as chequeStatus",
        "payments.status",
        "receipts.id as receiptId",
        "receipts.number as receiptNumber",
        "users.full_name as createdBy",
      ])
      .where("payments.centre_id", "=", centreId)
      .$if(query.from !== undefined, (qb) => qb.where(sql<string>`(payments.received_at at time zone ${centre.timezone})::date`, ">=", query.from!))
      .$if(query.to !== undefined, (qb) => qb.where(sql<string>`(payments.received_at at time zone ${centre.timezone})::date`, "<=", query.to!))
      .$if(query.method !== undefined, (qb) => qb.where("payments.method", "=", query.method!))
      .$if(query.userId !== undefined, (qb) => qb.where("payments.created_by", "=", query.userId!))
      .$if(query.studentId !== undefined, (qb) => qb.where("payments.student_id", "=", query.studentId!))
      .$if(query.renterId !== undefined, (qb) => qb.where("payments.renter_id", "=", query.renterId!))
      .orderBy("payments.received_at", "desc")
      .limit(query.pageSize + 1)
      .offset((query.page - 1) * query.pageSize)
      .execute();
    return { items: rows.slice(0, query.pageSize), hasMore: rows.length > query.pageSize, page: query.page };
  });

  /** Cheque life cycle. A bounced cheque stops paying its instalments, which become due again. */
  app.post("/:id/cheque-status", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = chequeStatusBody.parse(request.body);
    if (body.status === "bounced" && !body.reason) throw unprocessable("reason_required", "a bounced cheque needs a reason");
    return db.transaction().execute(async (trx) => {
      const payment = await trx
        .selectFrom("payments")
        .select(["id", "student_id", "renter_id", "method", "cheque_status", "status", "amount"])
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!payment || payment.method !== "cheque") throw notFound("cheque payment");
      if (payment.status !== "valid") throw conflict("payment_cancelled", "the payment is cancelled");
      if (!CHEQUE_FLOW[payment.cheque_status!]!.includes(body.status))
        throw conflict("invalid_transition", `a ${payment.cheque_status} cheque cannot become ${body.status}`);
      await lockPayer(trx, payerOfRow(payment), actor.centreId);
      await trx.updateTable("payments").set({ cheque_status: body.status }).where("id", "=", id).execute();
      if (body.status === "bounced") {
        await recordFinancialEvents(trx, [
          {
            centreId: actor.centreId,
            type: "cheque_bounced",
            amount: -payment.amount,
            userId: actor.userId,
            studentId: payment.student_id,
            renterId: payment.renter_id,
            payload: { paymentId: id, reason: body.reason },
          },
        ]);
        await settlePayer(trx, actor.centreId, payerOfRow(payment), actor.userId);
      }
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "payment.cheque_status",
        objectType: "payment",
        objectId: id,
        before: { chequeStatus: payment.cheque_status },
        after: { chequeStatus: body.status },
        reason: body.reason ?? null,
      });
      return { id, chequeStatus: body.status };
    });
  });

  /** Never deleted: a cancelled payment keeps its line, gets a cancellation receipt and stops paying anything. */
  app.post("/:id/cancel", { preHandler: app.requirePermission("payments:cancel") }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = cancelBody.parse(request.body);
    const result = await db.transaction().execute(async (trx) => {
      const payment = await trx
        .selectFrom("payments")
        .select(["id", "student_id", "renter_id", "status", "amount", "kind"])
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!payment) throw notFound("payment");
      if (payment.status === "cancelled") throw conflict("already_cancelled", "the payment is already cancelled");
      await assertCashOpen(trx, actor.centreId);
      const payer = payerOfRow(payment);
      await lockPayer(trx, payer, actor.centreId);
      const original = await trx
        .selectFrom("receipts")
        .select(["id", "number"])
        .where("payment_id", "=", id)
        .where("kind", "!=", "cancellation")
        .executeTakeFirstOrThrow();
      if (payment.kind === "payment") {
        const credit = await payerCredit(trx, payer);
        const allocated = await trx
          .selectFrom("effective_allocations")
          .select(sql<number>`coalesce(sum(amount), 0)::bigint`.as("sum"))
          .where("payment_id", "=", id)
          .executeTakeFirstOrThrow();
        // Money already refunded to the student cannot be taken back by cancelling the payment it came from.
        if (credit - (payment.amount - Number(allocated.sum)) < 0)
          throw conflict("credit_refunded", "part of this payment was refunded; cancel the refund first");
      }
      const axes = await allocationAxes(trx, id);
      await trx
        .updateTable("payments")
        .set({ status: "cancelled", cancelled_at: new Date(), cancelled_by: actor.userId, cancel_reason: body.reason })
        .where("id", "=", id)
        .execute();
      await recordFinancialEvents(trx, [
        ...axes.map((a) => ({
          centreId: actor.centreId,
          type: "payment_cancelled" as const,
          amount: -a.amount,
          userId: actor.userId,
          studentId: payment.student_id,
          renterId: payment.renter_id,
          rentalId: a.rentalId,
          roomId: a.roomId,
          installmentId: a.installmentId,
          enrolmentId: a.enrolmentId,
          groupId: a.groupId,
          studyId: a.studyId,
          trainingId: a.trainingId,
          instructorId: a.instructorId,
          payload: { paymentId: id },
        })),
        ...(payment.amount - axes.reduce((s, a) => s + a.amount, 0) !== 0
          ? [
              {
                centreId: actor.centreId,
                type: "payment_cancelled" as const,
                amount: -(payment.amount - axes.reduce((s, a) => s + a.amount, 0)),
                userId: actor.userId,
                studentId: payment.student_id,
                renterId: payment.renter_id,
                payload: { paymentId: id },
              },
            ]
          : []),
      ]);
      const receipt = await issueReceipt(trx, {
        centreId: actor.centreId,
        paymentId: id,
        kind: "cancellation",
        lines: [],
        cancels: { receiptId: original.id, number: original.number, reason: body.reason },
        userId: actor.userId,
      });
      await settlePayer(trx, actor.centreId, payer, actor.userId);
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "payment.cancelled",
        objectType: "payment",
        objectId: id,
        before: { status: "valid" },
        after: { status: "cancelled", receipt: receipt.number },
        reason: body.reason,
      });
      return { id, status: "cancelled", cancellationReceipt: receipt };
    });
    return result;
  });

  /** Gives back part of the student's credit. Recorded as a negative payment with its own receipt. */
  app.post("/refunds", { preHandler: app.requirePermission("payments:cancel") }, async (request, reply) => {
    const actor = request.user!;
    const body = refundBody.parse(request.body);
    if ((body.method === "cheque") !== !!body.cheque) throw unprocessable("invalid_cheque", "a cheque needs its number and bank, other methods none");
    const payer = payerOf(body);
    const result = await db.transaction().execute(async (trx) => {
      await assertCashOpen(trx, actor.centreId);
      await lockPayer(trx, payer, actor.centreId);
      const credit = await payerCredit(trx, payer);
      if (body.amount > credit) throw conflict("insufficient_credit", `the available credit is ${credit} millimes`);
      const refund = await trx
        .insertInto("payments")
        .values({
          centre_id: actor.centreId,
          kind: "refund",
          student_id: body.studentId ?? null,
          renter_id: body.renterId ?? null,
          amount: -body.amount,
          method: body.method,
          cheque_number: body.cheque?.number ?? null,
          cheque_bank: body.cheque?.bank ?? null,
          cheque_status: body.method === "cheque" ? "received" : null,
          note: body.reason,
          created_by: actor.userId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await recordFinancialEvents(trx, [
        {
          centreId: actor.centreId,
          type: "payment_received",
          amount: -body.amount,
          userId: actor.userId,
          studentId: body.studentId ?? null,
          renterId: body.renterId ?? null,
          payload: { paymentId: refund.id, refund: true },
        },
      ]);
      const receipt = await issueReceipt(trx, {
        centreId: actor.centreId,
        paymentId: refund.id,
        kind: "refund",
        lines: [{ label: `Remboursement : ${body.reason}`, amount: -body.amount }],
        userId: actor.userId,
      });
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "payment.refunded",
        objectType: "payment",
        objectId: refund.id,
        after: body,
        reason: body.reason,
      });
      return { paymentId: refund.id, receipt };
    });
    return reply.status(201).send(result);
  });
};
