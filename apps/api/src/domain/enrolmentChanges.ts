import { addDays } from "@gcf/shared";
import { sql, type Transaction } from "kysely";
import type { Database } from "../db/types.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { buildSchedule, loadGroupBilling } from "./enrolmentSchedule.js";
import { recordFinancialEvents } from "./financialEvents.js";
import { lockStudent, settleStudent } from "./ledger.js";

interface Actor {
  centreId: string;
  userId: string;
}

async function loadActiveEnrolment(trx: Transaction<Database>, enrolmentId: string, centreId: string) {
  const enrolment = await trx
    .selectFrom("enrolments")
    .selectAll()
    .where("id", "=", enrolmentId)
    .where("centre_id", "=", centreId)
    .forUpdate()
    .executeTakeFirst();
  if (!enrolment) throw notFound("enrolment");
  if (enrolment.status !== "active") throw conflict("enrolment_closed", "the enrolment is no longer active");
  return enrolment;
}

/** Open charges of an enrolment due on or after `from` that have received nothing yet. */
async function untouchedChargesFrom(trx: Transaction<Database>, enrolmentId: string, from: string) {
  return trx
    .selectFrom("installments")
    .leftJoin(trx.selectFrom("effective_allocations").select(["installment_id", sql<number>`sum(amount)::bigint`.as("paid")]).groupBy("installment_id").as("p"), "p.installment_id", "installments.id")
    .select(["installments.id", "installments.label", "installments.amount", "installments.due_date as dueDate", "installments.original_due_date as originalDueDate", "installments.postponement_count as postponementCount"])
    .where("installments.enrolment_id", "=", enrolmentId)
    .where("installments.kind", "=", "charge")
    .where("installments.status", "=", "open")
    .where("installments.session_id", "is", null)
    .where("installments.due_date", ">=", from)
    .where(sql<boolean>`coalesce(p.paid, 0) = 0`)
    .orderBy("installments.due_date")
    .execute();
}

export interface TransferInput {
  newGroupId: string;
  effectiveDate: string;
  mode: "keep" | "reprice";
  reason: string;
}

/**
 * Change of group. Attendance and payments stay with the old enrolment; unpaid future instalments move to the
 * new one, unchanged (keep) or re-priced at the new group's monthly tariff (reprice). Sessions before the
 * effective date stay with the old group, so pay follows naturally.
 */
export async function transferEnrolment(trx: Transaction<Database>, actor: Actor, enrolmentId: string, input: TransferInput) {
  const old = await loadActiveEnrolment(trx, enrolmentId, actor.centreId);
  await lockStudent(trx, old.student_id, actor.centreId);
  if (input.newGroupId === old.group_id) throw unprocessable("same_group", "choose another group");
  if (input.effectiveDate <= old.effective_date) throw unprocessable("invalid_date", "the change must take effect after the enrolment started");
  const from = await loadGroupBilling(trx, old.group_id, actor.centreId);
  const to = await loadGroupBilling(trx, input.newGroupId, actor.centreId);
  if (to.status !== "active") throw unprocessable("group_archived", "the new group is archived");
  if (input.effectiveDate > to.endDate) throw unprocessable("after_group_end", "the new group ends before the effective date");
  const sameOffer = from.kind === to.kind && (from.kind === "study" ? from.studyId === to.studyId : from.trainingId === to.trainingId);
  if (!sameOffer) throw unprocessable("different_offer", "a change of group stays within the same study or training; otherwise drop and enrol again");
  if (input.mode === "reprice" && old.payment_mode !== "monthly") throw unprocessable("reprice_not_applicable", "re-pricing applies to monthly billing only");

  await trx.selectFrom("groups").select("id").where("id", "=", to.groupId).forUpdate().executeTakeFirstOrThrow();
  const enrolled = await trx.selectFrom("enrolments").select((eb) => eb.fn.countAll<number>().as("count")).where("group_id", "=", to.groupId).where("status", "=", "active").executeTakeFirstOrThrow();
  if (Number(enrolled.count) >= to.capacity) throw conflict("group_full", "the new group has reached its capacity");
  const already = await trx.selectFrom("enrolments").select("id").where("student_id", "=", old.student_id).where("group_id", "=", to.groupId).where("status", "=", "active").executeTakeFirst();
  if (already) throw conflict("already_enrolled", "the student is already enrolled in that group");

  await trx.updateTable("enrolments").set({ status: "transferred", end_date: addDays(input.effectiveDate, -1), ended_reason: input.reason }).where("id", "=", old.id).execute();
  const created = await trx
    .insertInto("enrolments")
    .values({ centre_id: actor.centreId, student_id: old.student_id, group_id: to.groupId, effective_date: input.effectiveDate, payment_mode: old.payment_mode, plan_id: old.plan_id, transferred_from_id: old.id, created_by: actor.userId })
    .returning("id")
    .executeTakeFirstOrThrow();

  const moving = await untouchedChargesFrom(trx, old.id, input.effectiveDate);
  const cancelled: { id: string; amount: number }[] = [];
  for (const charge of moving) {
    await trx.updateTable("installments").set({ status: "cancelled", cancelled_at: new Date(), cancelled_by: actor.userId, cancel_reason: `changement de groupe : ${input.reason}` }).where("id", "=", charge.id).execute();
    cancelled.push({ id: charge.id, amount: charge.amount });
  }
  let issued: { id: string; amount: number }[] = [];
  if (input.mode === "keep") {
    if (moving.length) {
      issued = await trx
        .insertInto("installments")
        .values(moving.map((c) => ({ centre_id: actor.centreId, enrolment_id: created.id, label: c.label, kind: "charge" as const, amount: c.amount, due_date: c.dueDate, original_due_date: c.originalDueDate, postponement_count: c.postponementCount, discount_status: null, carried_from_id: c.id, created_by: actor.userId })))
        .returning(["id", "amount"])
        .execute();
    }
  } else if (moving.length) {
    const lines = await buildSchedule(trx, to, { paymentMode: "monthly", effectiveDate: input.effectiveDate, firstDueDate: moving[0]!.dueDate }, actor.centreId);
    if (lines.length) {
      issued = await trx
        .insertInto("installments")
        .values(lines.map((l) => ({ centre_id: actor.centreId, enrolment_id: created.id, label: l.label, kind: "charge" as const, amount: l.amount, due_date: l.dueDate, original_due_date: l.dueDate, discount_status: null, created_by: actor.userId })))
        .returning(["id", "amount"])
        .execute();
    }
  }
  const axesOld = { studentId: old.student_id, enrolmentId: old.id, groupId: from.groupId, studyId: from.studyId, trainingId: from.trainingId, instructorId: from.instructorId };
  const axesNew = { studentId: old.student_id, enrolmentId: created.id, groupId: to.groupId, studyId: to.studyId, trainingId: to.trainingId, instructorId: to.instructorId };
  await recordFinancialEvents(trx, [
    ...cancelled.map((c) => ({ centreId: actor.centreId, type: "installment_cancelled" as const, amount: -c.amount, userId: actor.userId, installmentId: c.id, ...axesOld })),
    ...issued.map((c) => ({ centreId: actor.centreId, type: "installment_issued" as const, amount: c.amount, userId: actor.userId, installmentId: c.id, ...axesNew })),
  ]);
  await settleStudent(trx, actor.centreId, old.student_id, actor.userId);
  return { oldEnrolmentId: old.id, newEnrolmentId: created.id, movedInstallments: moving.length, cancelledTotal: cancelled.reduce((s, c) => s + c.amount, 0), issuedTotal: issued.reduce((s, c) => s + c.amount, 0) };
}

/** Drop-out: a dated status, unpaid instalments due after the date are cancelled, nothing is refunded automatically. */
export async function dropEnrolment(trx: Transaction<Database>, actor: Actor, enrolmentId: string, input: { date: string; reason: string }) {
  const enrolment = await loadActiveEnrolment(trx, enrolmentId, actor.centreId);
  await lockStudent(trx, enrolment.student_id, actor.centreId);
  if (input.date < enrolment.effective_date) throw unprocessable("invalid_date", "the drop-out date is before the enrolment");
  const group = await loadGroupBilling(trx, enrolment.group_id, actor.centreId);
  await trx.updateTable("enrolments").set({ status: "dropped", end_date: input.date, ended_reason: input.reason }).where("id", "=", enrolment.id).execute();
  const charges = await untouchedChargesFrom(trx, enrolment.id, addDays(input.date, 1));
  for (const c of charges) {
    await trx.updateTable("installments").set({ status: "cancelled", cancelled_at: new Date(), cancelled_by: actor.userId, cancel_reason: `abandon : ${input.reason}` }).where("id", "=", c.id).execute();
  }
  await recordFinancialEvents(
    trx,
    charges.map((c) => ({ centreId: actor.centreId, type: "installment_cancelled" as const, amount: -c.amount, userId: actor.userId, installmentId: c.id, studentId: enrolment.student_id, enrolmentId: enrolment.id, groupId: group.groupId, studyId: group.studyId, trainingId: group.trainingId, instructorId: group.instructorId })),
  );
  return { enrolmentId: enrolment.id, cancelledInstallments: charges.length };
}
