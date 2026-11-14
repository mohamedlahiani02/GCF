import { formatTnd } from "@gcf/shared";
import { sql, type Kysely } from "kysely";
import { writeAudit } from "../audit.js";
import type { Database } from "../db/types.js";
import type { Mailer } from "../mail.js";
import { centreClock } from "./ledger.js";
import { installmentActivity, type FinancialActivity } from "./paymentActivity.js";

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

export interface ReminderPayer {
  kind: "student" | "member" | "renter";
  id: string;
}

export interface OverduePayer {
  payerKind: ReminderPayer["kind"];
  payerId: string;
  payerName: string;
  studentId: string | null;
  memberId: string | null;
  renterId: string | null;
  firstName: string;
  lastName: string;
  phone: string | null;
  recipient: string | null;
  total: number;
  items: { installmentId: string; label: string; dueDate: string; remaining: number; activity: FinancialActivity }[];
}

export interface ReminderResult {
  studentId?: string;
  memberId?: string;
  renterId?: string;
  status: ReminderStatus;
}

/**
 * Overdue instalments grouped by payer, after the centre's grace period and within the selected activity.
 * Student reminders use the receipt address, the guardian of a minor, or the student's own address.
 */
export async function overdueByPayer(
  db: Kysely<Database>,
  centreId: string,
  activity?: FinancialActivity,
  payerKind?: ReminderPayer["kind"],
): Promise<OverduePayer[]> {
  const { today, graceDays } = await centreClock(db, centreId);
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() - graceDays);
  const cutoff = limit.toISOString().slice(0, 10);
  const rows = await db
    .selectFrom("installments")
    .leftJoin("enrolments", "enrolments.id", "installments.enrolment_id")
    .leftJoin("students", "students.id", "enrolments.student_id")
    .leftJoin("rentals", "rentals.id", "installments.rental_id")
    .leftJoin("renters", "renters.id", "rentals.renter_id")
    .leftJoin("members", "members.id", "installments.member_id")
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
      "members.id as memberId",
      "renters.id as renterId",
      sql<string>`coalesce(students.first_name, members.first_name, renters.name, '')`.as("firstName"),
      sql<string>`coalesce(students.last_name, members.last_name, '')`.as("lastName"),
      sql<string>`coalesce(students.first_name || ' ' || students.last_name, renters.name, concat_ws(' ', members.first_name, members.last_name))`.as(
        "payerName",
      ),
      sql<string | null>`coalesce(students.phone, members.phone, renters.phone)`.as("phone"),
      "students.email",
      "members.email as memberEmail",
      "renters.email as renterEmail",
      "students.receipt_email as receiptEmail",
      "students.guardian_email as guardianEmail",
      "students.is_minor as isMinor",
      "installments.id as installmentId",
      "installments.label",
      "installments.due_date as dueDate",
      installmentActivity.as("activity"),
      sql<number>`installments.amount - coalesce(p.paid, 0)`.as("remaining"),
    ])
    .where("installments.centre_id", "=", centreId)
    .$if(activity !== undefined, (qb) => qb.where(installmentActivity, "=", activity!))
    .$if(payerKind === "student", (qb) => qb.where("students.id", "is not", null))
    .$if(payerKind === "member", (qb) => qb.where("members.id", "is not", null))
    .$if(payerKind === "renter", (qb) => qb.where("renters.id", "is not", null))
    .where("installments.kind", "=", "charge")
    .where("installments.status", "=", "open")
    .where("installments.due_date", "<", cutoff)
    .where(sql<boolean>`installments.amount - coalesce(p.paid, 0) > 0`)
    .orderBy(sql`coalesce(students.last_name, members.last_name, renters.name)`)
    .orderBy(sql`coalesce(students.first_name, members.first_name, renters.name)`)
    .orderBy(sql`coalesce(students.id, members.id, renters.id)`)
    .orderBy("installments.due_date")
    .orderBy("installments.id")
    .execute();
  const byPayer = new Map<string, OverduePayer>();
  for (const r of rows) {
    const kind = r.studentId ? "student" : r.memberId ? "member" : "renter";
    const id = r.studentId ?? r.memberId ?? r.renterId;
    if (!id) continue;
    const key = `${kind}:${id}`;
    const entry = byPayer.get(key) ?? {
      payerKind: kind,
      payerId: id,
      payerName: r.payerName,
      studentId: r.studentId,
      memberId: r.memberId,
      renterId: r.renterId,
      firstName: r.firstName,
      lastName: r.lastName,
      phone: r.phone,
      recipient: r.studentId ? (r.receiptEmail ?? (r.isMinor ? r.guardianEmail : r.email) ?? r.email) : (r.memberEmail ?? r.renterEmail),
      total: 0,
      items: [],
    };
    entry.items.push({ installmentId: r.installmentId, label: r.label, dueDate: r.dueDate, remaining: Number(r.remaining), activity: r.activity });
    entry.total += Number(r.remaining);
    byPayer.set(key, entry);
  }
  return [...byPayer.values()];
}

/** Existing student automations keep their student-only scope and result shape. */
export async function overdueByStudent(db: Kysely<Database>, centreId: string): Promise<OverdueStudent[]> {
  const list = await overdueByPayer(db, centreId, undefined, "student");
  return list.map((entry) => ({
    studentId: entry.studentId!,
    firstName: entry.firstName,
    lastName: entry.lastName,
    phone: entry.phone,
    recipient: entry.recipient,
    total: entry.total,
    items: entry.items.map(({ activity: _activity, ...item }) => item),
  }));
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
  const results = await sendPayerReminders(
    db,
    mailer,
    centreId,
    studentIds.map((id) => ({ kind: "student", id })),
    sentBy,
    reason,
  );
  return results.map((result) => ({ studentId: result.studentId!, status: result.status }));
}

/** Re-read the selected activity before sending so paid or out-of-scope charges never enter a reminder. */
export async function sendPayerReminders(
  db: Kysely<Database>,
  mailer: Mailer,
  centreId: string,
  payers: ReminderPayer[],
  sentBy: string | null,
  reason: string | null = null,
  activity?: FinancialActivity,
): Promise<ReminderResult[]> {
  const centre = await db.selectFrom("centres").select("name").where("id", "=", centreId).executeTakeFirstOrThrow();
  const list = await overdueByPayer(db, centreId, activity);
  const results: ReminderResult[] = [];
  const uniquePayers = new Map(payers.map((payer) => [`${payer.kind}:${payer.id}`, payer]));
  for (const payer of uniquePayers.values()) {
    const resultId = payer.kind === "student" ? { studentId: payer.id } : payer.kind === "member" ? { memberId: payer.id } : { renterId: payer.id };
    const entry = list.find((e) => e.payerKind === payer.kind && e.payerId === payer.id);
    if (!entry) {
      results.push({ ...resultId, status: "nothing_due" });
      continue;
    }
    if (!entry.recipient) {
      results.push({ ...resultId, status: "no_recipient" });
      continue;
    }
    const lines = entry.items.map((i) => `- ${i.label} : ${tnd(i.remaining)}, échue le ${frDate(i.dueDate)}`).join("\n");
    let status: "sent" | "failed" = "sent";
    let error: string | null = null;
    try {
      await mailer.send({
        to: entry.recipient,
        subject: `${centre.name} : rappel d'échéance`,
        text: `Bonjour,\n\nSauf erreur de notre part, les échéances suivantes de ${entry.payerName} restent à régler :\n\n${lines}\n\nTotal : ${tnd(entry.total)}\n\nMerci de régulariser auprès du secrétariat. Si le règlement a déjà été effectué, veuillez ne pas tenir compte de ce message.\n\n${centre.name}`,
      });
    } catch (sendError) {
      status = "failed";
      error = sendError instanceof Error ? sendError.message.slice(0, 500) : "unknown error";
    }
    await db
      .insertInto("mail_dispatches")
      .values({
        centre_id: centreId,
        kind: "reminder",
        student_id: entry.studentId,
        member_id: entry.memberId,
        renter_id: entry.renterId,
        recipient: entry.recipient,
        status,
        error,
        sent_by: sentBy,
      })
      .execute();
    results.push({ ...resultId, status });
  }
  await writeAudit(db, {
    centreId,
    userId: sentBy,
    action: "reminders.sent",
    objectType: "reminder",
    objectId: new Date().toISOString(),
    after: activity ? { activity, results } : results,
    reason,
  });
  return results;
}
