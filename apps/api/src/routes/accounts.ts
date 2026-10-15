import { formatTnd } from "@gcf/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { can } from "../auth/permissions.js";
import { centreClock, installmentBalances, lockStudent, studentTotals } from "../domain/ledger.js";
import { conflict, HttpError, notFound, unprocessable } from "../errors.js";
import { idParam, isoDate, reason, uuid } from "../validation.js";

const postponeBody = z.object({ toDate: isoDate, reason }).strict();
const decisionBody = z.object({ approve: z.boolean(), reason: reason.optional() }).strict();
const remindersSendBody = z.object({ studentIds: z.array(uuid).min(1).max(500) }).strict();

const NARROW_NBSP = String.fromCharCode(0x202f);
const tnd = (amount: number) => `${formatTnd(amount, "fr").split(NARROW_NBSP).join(" ")} TND`;
const frDate = (iso: string) => iso.split("-").reverse().join("/");

export const accountRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;

  /** Everything a money screen shows about a student: schedule, payments, credit, postponements, history. */
  app.get("/students/:id/account", { preHandler: app.requirePermission("payments:read") }, async (request) => {
    const centreId = request.user!.centreId;
    const { id } = idParam.parse(request.params);
    const student = await db.selectFrom("students").select(["id", "first_name as firstName", "last_name as lastName", "is_minor as isMinor", "guardian_name as guardianName", "phone", "email", "receipt_email as receiptEmail"]).where("id", "=", id).where("centre_id", "=", centreId).executeTakeFirst();
    if (!student) throw notFound("student");
    const installments = await installmentBalances(db, centreId, { studentId: id });
    const totals = await studentTotals(db, centreId, id);
    const payments = await db
      .selectFrom("payments")
      .leftJoin("receipts", (join) => join.onRef("receipts.payment_id", "=", "payments.id").on("receipts.kind", "!=", "cancellation"))
      .select(["payments.id", "payments.kind", "payments.received_at as receivedAt", "payments.amount", "payments.method", "payments.cheque_number as chequeNumber", "payments.cheque_status as chequeStatus", "payments.status", "payments.cancel_reason as cancelReason", "receipts.id as receiptId", "receipts.number as receiptNumber"])
      .where("payments.student_id", "=", id)
      .orderBy("payments.received_at", "desc")
      .execute();
    const postponements = await db
      .selectFrom("postponements")
      .innerJoin("installments", "installments.id", "postponements.installment_id")
      .innerJoin("enrolments", "enrolments.id", "installments.enrolment_id")
      .select(["postponements.id", "postponements.installment_id as installmentId", "installments.label", "postponements.from_date as fromDate", "postponements.to_date as toDate", "postponements.reason", "postponements.status", "postponements.requested_at as requestedAt", "postponements.decision_reason as decisionReason"])
      .where("enrolments.student_id", "=", id)
      .orderBy("postponements.requested_at", "desc")
      .execute();
    const enrolmentEvents = await db
      .selectFrom("enrolments")
      .innerJoin("groups", "groups.id", "enrolments.group_id")
      .select(["enrolments.id", "groups.name as groupName", "enrolments.effective_date as effectiveDate", "enrolments.end_date as endDate", "enrolments.status", "enrolments.transferred_from_id as transferredFromId", "enrolments.ended_reason as endedReason", "enrolments.created_at as createdAt"])
      .where("enrolments.student_id", "=", id)
      .execute();
    const timeline = [
      ...payments.map((p) => ({ at: p.receivedAt, type: p.status === "cancelled" ? "payment_cancelled" : p.kind === "refund" ? "refund" : "payment", label: `${p.kind === "refund" ? "Remboursement" : "Paiement"} ${tnd(Math.abs(p.amount))}${p.receiptNumber ? ` (${p.receiptNumber})` : ""}`, detail: p.cancelReason })),
      ...postponements.map((p) => ({ at: p.requestedAt, type: "postponement", label: `Report : ${p.label}, du ${frDate(p.fromDate)} au ${frDate(p.toDate)}`, detail: `${p.reason} (${p.status})` })),
      ...enrolmentEvents.map((e) => ({ at: e.createdAt, type: e.transferredFromId ? "group_change" : "enrolment", label: `${e.transferredFromId ? "Changement de groupe vers" : "Inscription"} ${e.groupName}, effet le ${frDate(e.effectiveDate)}`, detail: e.endedReason })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return { student, totals, installments, payments, postponements, timeline };
  });

  /** Moves a due date, with a mandatory reason; the original date is always kept. */
  app.post("/installments/:id/postpone", { preHandler: app.requirePermission("payments:write") }, async (request, reply) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = postponeBody.parse(request.body);
    const result = await db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("installments")
        .innerJoin("enrolments", "enrolments.id", "installments.enrolment_id")
        .innerJoin("centres", "centres.id", "installments.centre_id")
        .select(["installments.id", "installments.kind", "installments.status", "installments.due_date as dueDate", "installments.postponement_count as count", "enrolments.student_id as studentId", "centres.max_postponements as max", "centres.postponement_requires_approval as requiresApproval"])
        .where("installments.id", "=", id)
        .where("installments.centre_id", "=", actor.centreId)
        .executeTakeFirst();
      if (!row || row.kind !== "charge" || row.status !== "open") throw notFound("open instalment");
      await lockStudent(trx, row.studentId, actor.centreId);
      const [balance] = await installmentBalances(trx, actor.centreId, { installmentIds: [id] });
      if (!balance || balance.remaining <= 0) throw conflict("already_paid", "the instalment is already paid");
      if (body.toDate <= row.dueDate) throw unprocessable("date_not_later", "the new date must be after the current due date");
      if (row.count >= row.max) throw conflict("too_many_postponements", `an instalment can be postponed at most ${row.max} times`);
      const pending = await trx.selectFrom("postponements").select("id").where("installment_id", "=", id).where("status", "=", "pending").executeTakeFirst();
      if (pending) throw conflict("postponement_pending", "a postponement of this instalment is waiting for approval");
      const autoApproved = !row.requiresApproval || can(actor.role, "postponements:approve");
      const postponement = await trx
        .insertInto("postponements")
        .values({ centre_id: actor.centreId, installment_id: id, from_date: row.dueDate, to_date: body.toDate, reason: body.reason, requested_by: actor.userId, status: autoApproved ? "approved" : "pending", decided_by: autoApproved ? actor.userId : null, decided_at: autoApproved ? new Date() : null })
        .returning(["id", "status"])
        .executeTakeFirstOrThrow();
      if (autoApproved) {
        await trx.updateTable("installments").set({ due_date: body.toDate, postponement_count: row.count + 1 }).where("id", "=", id).execute();
      }
      await writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action: autoApproved ? "installment.postponed" : "installment.postponement_requested", objectType: "installment", objectId: id, before: { dueDate: row.dueDate }, after: { dueDate: body.toDate }, reason: body.reason });
      return postponement;
    });
    return reply.status(201).send(result);
  });

  app.post("/postponements/:id/decision", { preHandler: app.requirePermission("postponements:approve") }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = decisionBody.parse(request.body);
    if (!body.approve && !body.reason) throw unprocessable("reason_required", "a rejection needs a reason");
    return db.transaction().execute(async (trx) => {
      const p = await trx
        .selectFrom("postponements")
        .innerJoin("installments", "installments.id", "postponements.installment_id")
        .select(["postponements.id", "postponements.status", "postponements.installment_id as installmentId", "postponements.from_date as fromDate", "postponements.to_date as toDate", "installments.due_date as dueDate", "installments.postponement_count as count"])
        .where("postponements.id", "=", id)
        .where("postponements.centre_id", "=", actor.centreId)
        .forUpdate("postponements")
        .executeTakeFirst();
      if (!p) throw notFound("postponement");
      if (p.status !== "pending") throw conflict("already_decided", "this postponement has already been decided");
      if (body.approve && p.dueDate !== p.fromDate) throw conflict("due_date_changed", "the due date changed since the request");
      const status = body.approve ? "approved" : "rejected";
      await trx.updateTable("postponements").set({ status, decided_by: actor.userId, decided_at: new Date(), decision_reason: body.reason ?? null }).where("id", "=", id).execute();
      if (body.approve) await trx.updateTable("installments").set({ due_date: p.toDate, postponement_count: p.count + 1 }).where("id", "=", p.installmentId).execute();
      await writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action: `postponement.${status}`, objectType: "installment", objectId: p.installmentId, after: { fromDate: p.fromDate, toDate: p.toDate, status }, reason: body.reason ?? null });
      return { id, status };
    });
  });

  /** Overdue instalments grouped by student, after the centre's grace period. */
  const overdue = async (centreId: string) => {
    const { today, graceDays } = await centreClock(db, centreId);
    const limit = new Date(`${today}T00:00:00Z`);
    limit.setUTCDate(limit.getUTCDate() - graceDays);
    const cutoff = limit.toISOString().slice(0, 10);
    const rows = await db
      .selectFrom("installments")
      .innerJoin("enrolments", "enrolments.id", "installments.enrolment_id")
      .innerJoin("students", "students.id", "enrolments.student_id")
      .leftJoin(db.selectFrom("effective_allocations").select(["installment_id", sql<number>`sum(amount)::bigint`.as("paid")]).groupBy("installment_id").as("p"), "p.installment_id", "installments.id")
      .select([
        "students.id as studentId",
        "students.first_name as firstName",
        "students.last_name as lastName",
        "students.phone",
        "students.email",
        "students.receipt_email as receiptEmail",
        "students.guardian_email as guardianEmail",
        "students.is_minor as isMinor",
        "installments.id as installmentId",
        "installments.label",
        "installments.due_date as dueDate",
        sql<number>`installments.amount - coalesce(p.paid, 0)`.as("remaining"),
      ])
      .where("installments.centre_id", "=", centreId)
      .where("installments.kind", "=", "charge")
      .where("installments.status", "=", "open")
      .where("installments.due_date", "<", cutoff)
      .where(sql<boolean>`installments.amount - coalesce(p.paid, 0) > 0`)
      .orderBy("students.last_name")
      .orderBy("installments.due_date")
      .execute();
    const byStudent = new Map<string, { studentId: string; firstName: string; lastName: string; phone: string | null; recipient: string | null; total: number; items: { installmentId: string; label: string; dueDate: string; remaining: number }[] }>();
    for (const r of rows) {
      const entry = byStudent.get(r.studentId) ?? {
        studentId: r.studentId,
        firstName: r.firstName,
        lastName: r.lastName,
        phone: r.phone,
        recipient: r.receiptEmail ?? (r.isMinor ? r.guardianEmail : r.email) ?? r.email,
        total: 0,
        items: [],
      };
      entry.items.push({ installmentId: r.installmentId, label: r.label, dueDate: r.dueDate, remaining: Number(r.remaining) });
      entry.total += Number(r.remaining);
      byStudent.set(r.studentId, entry);
    }
    return [...byStudent.values()];
  };

  app.get("/reminders", { preHandler: app.requirePermission("payments:read") }, async (request) => overdue(request.user!.centreId));

  app.post("/reminders/send", { preHandler: app.requirePermission("reminders:send") }, async (request) => {
    const actor = request.user!;
    const body = remindersSendBody.parse(request.body);
    if (!app.mailer) throw new HttpError(503, "mail_not_configured", "outgoing e-mail is not configured on this server");
    const centre = await db.selectFrom("centres").select("name").where("id", "=", actor.centreId).executeTakeFirstOrThrow();
    const wanted = new Set(body.studentIds);
    const results: { studentId: string; status: "sent" | "failed" | "no_recipient" | "nothing_due" }[] = [];
    const list = await overdue(actor.centreId);
    for (const studentId of wanted) {
      const entry = list.find((e) => e.studentId === studentId);
      if (!entry) {
        results.push({ studentId, status: "nothing_due" });
        continue;
      }
      if (!entry.recipient) {
        results.push({ studentId, status: "no_recipient" });
        continue;
      }
      const lines = entry.items.map((i) => `- ${i.label} : ${tnd(i.remaining)}, échue le ${frDate(i.dueDate)}`).join("\n");
      let status: "sent" | "failed" = "sent";
      let error: string | null = null;
      try {
        await app.mailer.send({
          to: entry.recipient,
          subject: `${centre.name} : rappel d'échéance`,
          text: `Bonjour,\n\nSauf erreur de notre part, les échéances suivantes de ${entry.firstName} ${entry.lastName} restent à régler :\n\n${lines}\n\nTotal : ${tnd(entry.total)}\n\nMerci de régulariser auprès du secrétariat. Si le règlement a déjà été effectué, veuillez ne pas tenir compte de ce message.\n\n${centre.name}`,
        });
      } catch (sendError) {
        status = "failed";
        error = sendError instanceof Error ? sendError.message.slice(0, 500) : "unknown error";
      }
      await db.insertInto("mail_dispatches").values({ centre_id: actor.centreId, kind: "reminder", student_id: studentId, recipient: entry.recipient, status, error, sent_by: actor.userId }).execute();
      results.push({ studentId, status });
    }
    await writeAudit(db, { centreId: actor.centreId, userId: actor.userId, action: "reminders.sent", objectType: "reminder", objectId: new Date().toISOString(), after: results });
    return { results };
  });
};
