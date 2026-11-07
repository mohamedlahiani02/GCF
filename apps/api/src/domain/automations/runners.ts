import { addDays, formatTnd, previousMonth, type LocalMoment } from "@gcf/shared";
import { sql, type Kysely } from "kysely";
import { writeAudit } from "../../audit.js";
import type { Database, Module, Role } from "../../db/types.js";
import type { Mailer } from "../../mail.js";
import { calculateItems } from "../payItems.js";
import { computeCandidates, monthBounds, monthLabel } from "../payrollCalc.js";
import { lastReminderSent, overdueByStudent, sendReminders } from "../reminders.js";
import type { z } from "zod";
import type { digestParams, payrollParams, reminderParams } from "./definitions.js";
import { createProposal } from "./proposals.js";

const NARROW_NBSP = String.fromCharCode(0x202f);
const tnd = (amount: number) => `${formatTnd(amount, "fr").split(NARROW_NBSP).join(" ")} TND`;
const frDate = (iso: string) => iso.split("-").reverse().join("/");
/** "de mars 2026", "d'octobre 2026": French elides "de" before a vowel. */
const ofMonth = (month: string) => {
  const label = monthLabel(month);
  return /^[aeiouéh]/i.test(label) ? `d'${label}` : `de ${label}`;
};

export interface RunContext {
  db: Kysely<Database>;
  mailer: Mailer | null;
  centre: { id: string; name: string; timezone: string; modules: Module[] };
  moment: LocalMoment;
  now: Date;
  mode: "propose" | "auto";
  runId: string;
}

/** Thrown when a run cannot do its work; the run is recorded as failed with this message. */
export class RunFailure extends Error {}

async function staffRecipients(db: Kysely<Database>, centreId: string, roles: readonly Role[]): Promise<string[]> {
  if (!roles.length) return [];
  const rows = await db
    .selectFrom("users")
    .select("email")
    .where("centre_id", "=", centreId)
    .where("active", "=", true)
    .where("role", "in", [...roles])
    .orderBy("email")
    .execute();
  return rows.map((r) => r.email);
}

/** Sends one e-mail per recipient; returns how many were sent. A failed address does not stop the others. */
async function mailStaff(mailer: Mailer, to: string[], subject: string, text: string): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const address of to) {
    try {
      await mailer.send({ to: address, subject, text });
      sent += 1;
    } catch {
      failed += 1;
    }
  }
  return { sent, failed };
}

/**
 * Weekly reminders of overdue instalments. Students who owe less than the minimum, who have no address to write to,
 * or who were reminded too recently are left out. In propose mode the list waits in the proposals inbox; in auto mode
 * the e-mails leave at once, recorded in the audit log under no user.
 */
export async function runOverdueReminders(ctx: RunContext, params: z.infer<typeof reminderParams>): Promise<unknown> {
  const { db, centre } = ctx;
  const overdue = await overdueByStudent(db, centre.id);
  const last = await lastReminderSent(db, centre.id);
  const cutoff = ctx.now.getTime() - params.minDaysBetween * 86_400_000;
  const noRecipient = overdue.filter((s) => s.total >= params.minAmount && !s.recipient).length;
  const remindedRecently = overdue.filter((s) => s.total >= params.minAmount && s.recipient && (last.get(s.studentId)?.getTime() ?? 0) > cutoff).length;
  const selected = overdue.filter((s) => s.total >= params.minAmount && s.recipient && (last.get(s.studentId)?.getTime() ?? 0) <= cutoff);
  const total = selected.reduce((sum, s) => sum + s.total, 0);
  const skipped = { noRecipient, remindedRecently, belowMinimum: overdue.filter((s) => s.total < params.minAmount).length };
  if (!selected.length) return { students: 0, total: 0, skipped };

  if (ctx.mode === "propose") {
    const proposalId = await createProposal(db, {
      centreId: centre.id,
      kind: "reminders.send",
      title: `Relances de la semaine : ${selected.length} élève${selected.length > 1 ? "s" : ""}, ${tnd(total)}`,
      summary: {
        total,
        students: selected.map((s) => ({
          studentId: s.studentId,
          name: `${s.firstName} ${s.lastName}`,
          recipient: s.recipient,
          total: s.total,
          oldestDueDate: s.items[0]!.dueDate,
          installments: s.items.length,
        })),
        skipped,
      },
      payload: { studentIds: selected.map((s) => s.studentId) },
      runId: ctx.runId,
    });
    return { students: selected.length, total, skipped, proposalId };
  }
  if (!ctx.mailer) throw new RunFailure("outgoing e-mail is not configured on this server");
  const results = await sendReminders(
    db,
    ctx.mailer,
    centre.id,
    selected.map((s) => s.studentId),
    null,
    "relance hebdomadaire automatique",
  );
  return {
    students: selected.length,
    total,
    skipped,
    sent: results.filter((r) => r.status === "sent").length,
    failed: results.filter((r) => r.status === "failed").length,
  };
}

/**
 * The previous month's pay. Both modes compute what the rules produce and list the warnings (an instructor with no
 * applicable rule, a session whose sheet is not validated). Propose mode leaves the calculation to be confirmed;
 * auto mode stores the calculated items (never validated: validation stays a person's decision). The summary is
 * e-mailed to the chosen roles.
 */
export async function runPayrollMonth(ctx: RunContext, params: z.infer<typeof payrollParams>): Promise<unknown> {
  const { db, centre } = ctx;
  const month = previousMonth(ctx.moment.date.slice(0, 7));
  const { start, end } = monthBounds(month);
  const { candidates, warnings } = await computeCandidates(db, centre.id, { from: start, to: end, excludeValidated: true });
  const instructorIds = [...new Set([...candidates.map((c) => c.instructorId), ...warnings.map((w) => w.instructorId)])];
  const names = instructorIds.length
    ? await db.selectFrom("instructors").select(["id", "first_name", "last_name"]).where("id", "in", instructorIds).execute()
    : [];
  const nameOf = (id: string) => {
    const row = names.find((n) => n.id === id);
    return row ? `${row.first_name} ${row.last_name}` : id;
  };
  const byInstructor = [...new Set(candidates.map((c) => c.instructorId))].map((id) => {
    const own = candidates.filter((c) => c.instructorId === id);
    return { instructorId: id, name: nameOf(id), items: own.length, total: own.reduce((sum, c) => sum + c.amount, 0) };
  });
  const total = byInstructor.reduce((sum, i) => sum + i.total, 0);
  const warningList = warnings.map((w) => ({
    instructorId: w.instructorId,
    name: nameOf(w.instructorId),
    groupName: w.groupName,
    code: w.code,
    message: w.message,
  }));
  const summary: Record<string, unknown> = { month, total, instructors: byInstructor, warnings: warningList };

  if (byInstructor.length && ctx.mode === "propose") {
    summary.proposalId = await createProposal(db, {
      centreId: centre.id,
      kind: "payroll.calculate",
      title: `Paie ${ofMonth(month)} : ${byInstructor.length} intervenant${byInstructor.length > 1 ? "s" : ""}, ${tnd(total)}`,
      summary,
      payload: { month, instructorIds: byInstructor.map((i) => i.instructorId) },
      runId: ctx.runId,
    });
  }
  if (byInstructor.length && ctx.mode === "auto") {
    const calculated = { created: 0, unchanged: 0, replaced: 0 };
    for (const { instructorId } of byInstructor) {
      const result = await db
        .transaction()
        .execute((trx) => calculateItems(trx, { centreId: centre.id, userId: null }, instructorId, { from: start, to: end }));
      calculated.created += result.created;
      calculated.unchanged += result.unchanged;
      calculated.replaced += result.replaced;
    }
    summary.calculated = calculated;
  }

  const recipients = await staffRecipients(db, centre.id, params.notifyRoles);
  if (ctx.mailer && recipients.length) {
    const lines = [
      !byInstructor.length
        ? `Aucun élément de paie à calculer pour le mois ${ofMonth(month)}.`
        : ctx.mode === "auto"
          ? `La paie ${ofMonth(month)} a été calculée. Les éléments restent à valider dans Paie.`
          : `La paie ${ofMonth(month)} est prête à être calculée : confirmez-la dans Propositions.`,
      "",
      ...(byInstructor.length
        ? byInstructor.map((i) => `- ${i.name} : ${tnd(i.total)} (${i.items} élément${i.items > 1 ? "s" : ""})`)
        : ["Aucun élément de paie ce mois-ci."]),
      `Total : ${tnd(total)}`,
      ...(warningList.length
        ? ["", "Points à vérifier :", ...warningList.map((w) => `- ${w.name}${w.groupName ? `, ${w.groupName}` : ""} : ${w.message}`)]
        : []),
      "",
      centre.name,
    ];
    summary.mail = await mailStaff(ctx.mailer, recipients, `${centre.name} : paie ${ofMonth(month)}`, lines.join("\n"));
  }
  return summary;
}

/** Tomorrow's sessions and coworking bookings, and what waits in the proposals inbox, e-mailed to the chosen roles. */
export async function runDailyDigest(ctx: RunContext, params: z.infer<typeof digestParams>): Promise<unknown> {
  const { db, centre } = ctx;
  if (!ctx.mailer) throw new RunFailure("outgoing e-mail is not configured on this server");
  const tomorrow = addDays(ctx.moment.date, 1);
  const localTime = (column: string) => sql<string>`to_char(${sql.ref(column)} at time zone ${centre.timezone}, 'HH24:MI')`;

  const sessions = centre.modules.includes("training")
    ? await db
        .selectFrom("class_sessions")
        .innerJoin("groups", "groups.id", "class_sessions.group_id")
        .innerJoin("instructors", "instructors.id", "class_sessions.instructor_id")
        .leftJoin("rooms", "rooms.id", "class_sessions.room_id")
        .select([
          localTime("class_sessions.starts_at").as("start"),
          localTime("class_sessions.ends_at").as("end"),
          "groups.name as groupName",
          "rooms.name as roomName",
          sql<string>`instructors.first_name || ' ' || instructors.last_name`.as("instructor"),
        ])
        .where("class_sessions.centre_id", "=", centre.id)
        .where("class_sessions.status", "=", "scheduled")
        .where(sql<string>`to_char(class_sessions.starts_at at time zone ${centre.timezone}, 'YYYY-MM-DD')`, "=", tomorrow)
        .orderBy("class_sessions.starts_at")
        .execute()
    : [];
  const bookings = centre.modules.includes("coworking")
    ? await db
        .selectFrom("cw_bookings")
        .innerJoin("cw_resources", "cw_resources.id", "cw_bookings.resource_id")
        .leftJoin("members", "members.id", "cw_bookings.member_id")
        .select([
          localTime("cw_bookings.starts_at").as("start"),
          localTime("cw_bookings.ends_at").as("end"),
          "cw_resources.code as resource",
          "cw_bookings.status",
          sql<string | null>`members.first_name || coalesce(' ' || members.last_name, '')`.as("member"),
        ])
        .where("cw_bookings.centre_id", "=", centre.id)
        .where("cw_bookings.kind", "=", "booking")
        .where("cw_bookings.status", "in", ["requested", "confirmed"])
        .where(sql<string>`to_char(cw_bookings.starts_at at time zone ${centre.timezone}, 'YYYY-MM-DD')`, "=", tomorrow)
        .orderBy("cw_bookings.starts_at")
        .execute()
    : [];
  const pending = await db
    .selectFrom("proposals")
    .select(sql<number>`count(*)::integer`.as("count"))
    .where("centre_id", "=", centre.id)
    .where("status", "=", "pending")
    .where("expires_at", ">", sql<Date>`now()`)
    .executeTakeFirstOrThrow();

  const lines = [`Programme du ${frDate(tomorrow)}`, ""];
  if (centre.modules.includes("training")) {
    lines.push(`Séances (${sessions.length}) :`);
    lines.push(
      ...(sessions.length ? sessions.map((s) => `- ${s.start}-${s.end} ${s.groupName}, ${s.instructor}${s.roomName ? `, ${s.roomName}` : ""}`) : ["- aucune"]),
      "",
    );
  }
  if (centre.modules.includes("coworking")) {
    lines.push(`Réservations du coworking (${bookings.length}) :`);
    lines.push(
      ...(bookings.length
        ? bookings.map((b) => `- ${b.start}-${b.end} ${b.resource}${b.member ? `, ${b.member}` : ""}${b.status === "requested" ? " (demande à traiter)" : ""}`)
        : ["- aucune"]),
      "",
    );
  }
  if (pending.count) lines.push(`${pending.count} proposition${pending.count > 1 ? "s" : ""} en attente de confirmation.`, "");
  lines.push(centre.name);

  const recipients = await staffRecipients(db, centre.id, params.roles);
  const mail = await mailStaff(ctx.mailer, recipients, `${centre.name} : programme du ${frDate(tomorrow)}`, lines.join("\n"));
  const summary = {
    date: tomorrow,
    sessions: sessions.length,
    bookings: bookings.length,
    pendingProposals: pending.count,
    recipients: recipients.length,
    ...mail,
  };
  await writeAudit(db, {
    centreId: centre.id,
    userId: null,
    action: "automation.digest_sent",
    objectType: "automation_run",
    objectId: ctx.runId,
    after: summary,
  });
  return summary;
}
