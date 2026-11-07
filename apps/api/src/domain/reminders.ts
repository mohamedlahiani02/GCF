import { formatTnd } from "@gcf/shared";
import { sql, type Kysely } from "kysely";
import { writeAudit } from "../audit.js";
import type { Database } from "../db/types.js";
import type { Mailer } from "../mail.js";
import { centreClock } from "./ledger.js";

const NARROW_NBSP = String.fromCharCode(0x202f);
const tnd = (amount: number) => `${formatTnd(amount, "fr").split(NARROW_NBSP).join(" ")} TND`;
const frDate = (iso: string) => iso.split("-").reverse().join("/");

export interface OverdueStudent {
  studentId: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  recipient: string | null;
  total: number;
  items: { installmentId: string; label: string; dueDate: string; remaining: number }[];
}

export type ReminderStatus = "sent" | "failed" | "no_recipient" | "nothing_due";

/**
 * Overdue instalments grouped by student, after the centre's grace period. The reminder goes to the receipt
 * address when there is one, otherwise to the guardian of a minor or to the student.
 */
export async function overdueByStudent(db: Kysely<Database>, centreId: string): Promise<OverdueStudent[]> {
  const { today, graceDays } = await centreClock(db, centreId);
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() - graceDays);
  const cutoff = limit.toISOString().slice(0, 10);
  const rows = await db
    .selectFrom("installments")
    .innerJoin("enrolments", "enrolments.id", "installments.enrolment_id")
    .innerJoin("students", "students.id", "enrolments.student_id")
    .leftJoin(
      db
        .selectFrom("effective_allocations")
        .select(["installment_id", sql<number>`sum(amount)::bigint`.as("paid")])
        .groupBy("installment_id")
        .as("p"),
      "p.installment_id",
      "installments.id",
    )
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
  const byStudent = new Map<string, OverdueStudent>();
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
}

/** When each student last received a reminder that was actually sent. */
export async function lastReminderSent(db: Kysely<Database>, centreId: string): Promise<Map<string, Date>> {
  const rows = await db
    .selectFrom("mail_dispatches")
    .select(["student_id", sql<Date>`max(sent_at)`.as("last")])
    .where("centre_id", "=", centreId)
    .where("kind", "=", "reminder")
    .where("status", "=", "sent")
    .where("student_id", "is not", null)
    .groupBy("student_id")
    .execute();
  return new Map(rows.map((r) => [r.student_id!, new Date(r.last)]));
}

/**
 * E-mails a reminder to each listed student, with what is overdue at the moment of sending: a student who has paid
 * in the meantime gets nothing. Every attempt is logged in mail_dispatches and the batch in the audit log, under the
 * person who sent it, or under no one when an automation did.
 */
export async function sendReminders(
  db: Kysely<Database>,
  mailer: Mailer,
  centreId: string,
  studentIds: string[],
  sentBy: string | null,
  reason: string | null = null,
): Promise<{ studentId: string; status: ReminderStatus }[]> {
  const centre = await db.selectFrom("centres").select("name").where("id", "=", centreId).executeTakeFirstOrThrow();
  const list = await overdueByStudent(db, centreId);
  const results: { studentId: string; status: ReminderStatus }[] = [];
  for (const studentId of new Set(studentIds)) {
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
      await mailer.send({
        to: entry.recipient,
        subject: `${centre.name} : rappel d'échéance`,
        text: `Bonjour,\n\nSauf erreur de notre part, les échéances suivantes de ${entry.firstName} ${entry.lastName} restent à régler :\n\n${lines}\n\nTotal : ${tnd(entry.total)}\n\nMerci de régulariser auprès du secrétariat. Si le règlement a déjà été effectué, veuillez ne pas tenir compte de ce message.\n\n${centre.name}`,
      });
    } catch (sendError) {
      status = "failed";
      error = sendError instanceof Error ? sendError.message.slice(0, 500) : "unknown error";
    }
    await db
      .insertInto("mail_dispatches")
      .values({ centre_id: centreId, kind: "reminder", student_id: studentId, recipient: entry.recipient, status, error, sent_by: sentBy })
      .execute();
    results.push({ studentId, status });
  }
  await writeAudit(db, {
    centreId,
    userId: sentBy,
    action: "reminders.sent",
    objectType: "reminder",
    objectId: new Date().toISOString(),
    after: results,
    reason,
  });
  return results;
}
