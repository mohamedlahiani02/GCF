import { attendanceRate, rateToBasisPoints, type AttendanceStatus } from "@gcf/shared";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../db/types.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { recordFinancialEvents } from "./financialEvents.js";
import { lockStudent, settleStudent } from "./ledger.js";

type Db = Kysely<Database> | Transaction<Database>;

export interface SessionContext {
  id: string;
  centreId: string;
  groupId: string;
  groupName: string;
  groupKind: "study" | "training";
  studyId: string | null;
  trainingId: string | null;
  instructorId: string;
  roomId: string | null;
  startsAt: Date;
  endsAt: Date;
  localDate: string;
  status: "scheduled" | "held" | "cancelled";
  sheetStatus: "none" | "in_progress" | "validated";
  billingMode: "monthly" | "per_session" | null;
  sessionPrice: number | null;
  absenceBilled: boolean | null;
}

export async function loadSession(db: Db, sessionId: string, centreId: string, lock = false): Promise<SessionContext> {
  let query = db
    .selectFrom("class_sessions")
    .innerJoin("groups", "groups.id", "class_sessions.group_id")
    .innerJoin("centres", "centres.id", "class_sessions.centre_id")
    .leftJoin("studies", "studies.id", "groups.study_id")
    .leftJoin("training_sessions", "training_sessions.id", "groups.training_session_id")
    .select([
      "class_sessions.id",
      "class_sessions.centre_id as centreId",
      "class_sessions.group_id as groupId",
      "groups.name as groupName",
      "groups.kind as groupKind",
      "groups.study_id as studyId",
      "training_sessions.training_id as trainingId",
      "class_sessions.instructor_id as instructorId",
      "class_sessions.room_id as roomId",
      "class_sessions.starts_at as startsAt",
      "class_sessions.ends_at as endsAt",
      sql<string>`to_char(class_sessions.starts_at at time zone centres.timezone, 'YYYY-MM-DD')`.as("localDate"),
      "class_sessions.status",
      "class_sessions.sheet_status as sheetStatus",
      "studies.billing_mode as billingMode",
      sql<number | null>`coalesce(groups.price_override, studies.price)`.as("sessionPrice"),
      sql<boolean | null>`coalesce(groups.absence_billed_override, studies.absence_billed)`.as("absenceBilled"),
    ])
    .where("class_sessions.id", "=", sessionId)
    .where("class_sessions.centre_id", "=", centreId);
  if (lock) query = query.forUpdate("class_sessions");
  const session = await query.executeTakeFirst();
  if (!session) throw notFound("session");
  return session;
}

/** Students enrolled in the group on the session date, whatever became of the enrolment later. */
export async function enrolledOn(db: Db, groupId: string, localDate: string) {
  return db
    .selectFrom("enrolments")
    .innerJoin("students", "students.id", "enrolments.student_id")
    .select(["enrolments.id as enrolmentId", "students.id as studentId", "students.first_name as firstName", "students.last_name as lastName"])
    .where("enrolments.group_id", "=", groupId)
    .where("enrolments.effective_date", "<=", localDate)
    .where((eb) => eb.or([eb("enrolments.end_date", "is", null), eb("enrolments.end_date", ">=", localDate)]))
    .orderBy("students.last_name")
    .orderBy("students.first_name")
    .execute();
}

export interface SheetRow {
  studentId: string;
  enrolmentId: string;
  firstName: string;
  lastName: string;
  status: AttendanceStatus;
  saved: boolean;
  isGuest: boolean;
  originGroupName: string | null;
  hostSessionId: string | null;
  note: string | null;
}

/** The sheet as the secretariat sees it: every enrolled student, present by default until saved otherwise. */
export async function sheetRows(db: Db, session: SessionContext): Promise<SheetRow[]> {
  const enrolled = await enrolledOn(db, session.groupId, session.localDate);
  const records = await db
    .selectFrom("attendance_records")
    .innerJoin("students", "students.id", "attendance_records.student_id")
    .innerJoin("enrolments", "enrolments.id", "attendance_records.enrolment_id")
    .innerJoin("groups", "groups.id", "enrolments.group_id")
    .select([
      "attendance_records.student_id as studentId",
      "attendance_records.enrolment_id as enrolmentId",
      "students.first_name as firstName",
      "students.last_name as lastName",
      "attendance_records.status",
      "attendance_records.is_guest as isGuest",
      "attendance_records.host_session_id as hostSessionId",
      "attendance_records.note",
      "groups.name as originGroupName",
    ])
    .where("attendance_records.session_id", "=", session.id)
    .execute();
  const byStudent = new Map(records.map((r) => [r.studentId, r]));
  const rows: SheetRow[] = enrolled.map((e) => {
    const r = byStudent.get(e.studentId);
    return {
      studentId: e.studentId,
      enrolmentId: e.enrolmentId,
      firstName: e.firstName,
      lastName: e.lastName,
      status: r?.status ?? "present",
      saved: !!r,
      isGuest: false,
      originGroupName: null,
      hostSessionId: r?.hostSessionId ?? null,
      note: r?.note ?? null,
    };
  });
  for (const r of records.filter((x) => x.isGuest)) {
    rows.push({ studentId: r.studentId, enrolmentId: r.enrolmentId, firstName: r.firstName, lastName: r.lastName, status: "present", saved: true, isGuest: true, originGroupName: r.originGroupName, hostSessionId: null, note: r.note });
  }
  return rows;
}

export interface RecordInput {
  studentId: string;
  status: AttendanceStatus;
  note?: string | null | undefined;
  hostSessionId?: string | null | undefined;
}

/**
 * Saves attendance for enrolled students. A make-up in another group also writes the student as a guest
 * on the host session's sheet, linked back to the origin group.
 */
export async function saveRecords(trx: Transaction<Database>, session: SessionContext, inputs: RecordInput[], userId: string): Promise<void> {
  if (session.status === "cancelled") throw conflict("session_cancelled", "the session is cancelled");
  const enrolled = await enrolledOn(trx, session.groupId, session.localDate);
  const enrolmentOf = new Map(enrolled.map((e) => [e.studentId, e.enrolmentId]));
  for (const input of inputs) {
    const enrolmentId = enrolmentOf.get(input.studentId);
    if (!enrolmentId) throw unprocessable("not_enrolled", "a student on the sheet is not enrolled in this group on that date");
    let hostSessionId: string | null = null;
    if (input.status === "present_other_group") {
      if (!input.hostSessionId) throw unprocessable("host_session_required", "choose the session the student attended");
      const host = await loadSession(trx, input.hostSessionId, session.centreId, true);
      if (host.groupId === session.groupId) throw unprocessable("same_group", "the make-up must happen in another group");
      if (host.status === "cancelled") throw unprocessable("host_cancelled", "the host session is cancelled");
      if (host.sheetStatus === "validated") throw conflict("host_sheet_validated", "the host session sheet is already validated");
      hostSessionId = host.id;
    }
    const previous = await trx.selectFrom("attendance_records").select(["host_session_id"]).where("session_id", "=", session.id).where("student_id", "=", input.studentId).executeTakeFirst();
    if (previous?.host_session_id && previous.host_session_id !== hostSessionId) {
      await trx.deleteFrom("attendance_records").where("session_id", "=", previous.host_session_id).where("student_id", "=", input.studentId).where("is_guest", "=", true).execute();
    }
    await trx
      .insertInto("attendance_records")
      .values({ centre_id: session.centreId, session_id: session.id, student_id: input.studentId, enrolment_id: enrolmentId, status: input.status, host_session_id: hostSessionId, note: input.note ?? null, updated_by: userId })
      .onConflict((oc) => oc.columns(["session_id", "student_id"]).doUpdateSet({ status: input.status, host_session_id: hostSessionId, note: input.note ?? null, updated_by: userId, updated_at: new Date() }))
      .execute();
    if (hostSessionId) {
      await trx
        .insertInto("attendance_records")
        .values({ centre_id: session.centreId, session_id: hostSessionId, student_id: input.studentId, enrolment_id: enrolmentId, status: "present", is_guest: true, note: `Rattrapage : ${session.groupName}`, updated_by: userId })
        .onConflict((oc) => oc.columns(["session_id", "student_id"]).doUpdateSet({ status: "present", is_guest: true, updated_by: userId, updated_at: new Date() }))
        .execute();
      await trx.updateTable("class_sessions").set({ sheet_status: "in_progress" }).where("id", "=", hostSessionId).where("sheet_status", "=", "none").execute();
    }
  }
  if (session.sheetStatus === "none") {
    await trx.updateTable("class_sessions").set({ sheet_status: "in_progress" }).where("id", "=", session.id).execute();
  }
}

/** Per-session billing: one charge per billable enrolled student, absence billed or not according to the study. */
export async function syncSessionCharges(trx: Transaction<Database>, session: SessionContext, userId: string): Promise<void> {
  if (session.groupKind !== "study" || session.billingMode !== "per_session") return;
  const price = session.sessionPrice ?? 0;
  if (price === 0) return;
  const records = await trx
    .selectFrom("attendance_records")
    .innerJoin("enrolments", "enrolments.id", "attendance_records.enrolment_id")
    .select(["attendance_records.enrolment_id as enrolmentId", "attendance_records.student_id as studentId", "attendance_records.status"])
    .where("attendance_records.session_id", "=", session.id)
    .where("attendance_records.is_guest", "=", false)
    .where("enrolments.payment_mode", "=", "per_session")
    .execute();
  const existing = await trx.selectFrom("installments").select(["id", "enrolment_id"]).where("session_id", "=", session.id).where("status", "=", "open").execute();
  const touched = new Set<string>();
  const charged = new Map(existing.map((e) => [e.enrolment_id, e.id]));
  for (const r of records) {
    const billable = r.status === "present" || r.status === "present_other_group" || session.absenceBilled === true;
    const chargeId = charged.get(r.enrolmentId);
    if (billable !== !!chargeId) {
      await lockStudent(trx, r.studentId, session.centreId);
      touched.add(r.studentId);
    }
    if (billable && !chargeId) {
      const charge = await trx
        .insertInto("installments")
        .values({
          centre_id: session.centreId,
          enrolment_id: r.enrolmentId,
          label: `${session.groupName}, séance du ${session.localDate.split("-").reverse().join("/")}`,
          kind: "charge",
          amount: price,
          due_date: session.localDate,
          original_due_date: session.localDate,
          discount_status: null,
          session_id: session.id,
          created_by: userId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await recordFinancialEvents(trx, [
        { centreId: session.centreId, type: "installment_issued", amount: price, userId, installmentId: charge.id, studentId: r.studentId, enrolmentId: r.enrolmentId, groupId: session.groupId, studyId: session.studyId, instructorId: session.instructorId },
      ]);
    } else if (!billable && chargeId) {
      await cancelUnpaidCharge(trx, chargeId, userId, "attendance corrected: session not billable");
      await recordFinancialEvents(trx, [
        { centreId: session.centreId, type: "installment_cancelled", amount: -price, userId, installmentId: chargeId, studentId: r.studentId, enrolmentId: r.enrolmentId, groupId: session.groupId, studyId: session.studyId, instructorId: session.instructorId },
      ]);
    }
  }
  // New charges are paid straight away from any credit the student holds.
  for (const studentId of touched) await settleStudent(trx, session.centreId, studentId, userId);
}

/** A charge that already received money (payment or discount) cannot be cancelled: cancel the payment first. */
export async function cancelUnpaidCharge(trx: Transaction<Database>, installmentId: string, userId: string, reason: string): Promise<void> {
  const paid = await trx.selectFrom("effective_allocations").select(sql<number>`coalesce(sum(amount), 0)::bigint`.as("paid")).where("installment_id", "=", installmentId).executeTakeFirstOrThrow();
  if (Number(paid.paid) > 0) throw conflict("installment_paid", "this instalment has received a payment; cancel the payment first");
  await trx.updateTable("installments").set({ status: "cancelled", cancelled_at: new Date(), cancelled_by: userId, cancel_reason: reason }).where("id", "=", installmentId).execute();
}

/** Group attendance grid (students x sessions) with each student's rate under the group's effective settings. */
export async function groupAttendance(db: Db, groupId: string, centreId: string, from: string, to: string) {
  const settings = await db
    .selectFrom("groups")
    .innerJoin("centres", "centres.id", "groups.centre_id")
    .select([
      sql<boolean>`coalesce(groups.count_justified_override, centres.count_justified_as_present)`.as("countJustifiedAsPresent"),
      sql<boolean>`coalesce(groups.count_makeup_override, centres.count_makeup_as_present)`.as("countOtherGroupAsPresent"),
      "centres.timezone",
    ])
    .where("groups.id", "=", groupId)
    .where("groups.centre_id", "=", centreId)
    .executeTakeFirst();
  if (!settings) throw notFound("group");
  const sessions = await db
    .selectFrom("class_sessions")
    .select(["id", "starts_at as startsAt", sql<string>`to_char(starts_at at time zone ${settings.timezone}, 'YYYY-MM-DD')`.as("localDate")])
    .where("group_id", "=", groupId)
    .where("sheet_status", "=", "validated")
    .where(sql<string>`(starts_at at time zone ${settings.timezone})::date`, ">=", from)
    .where(sql<string>`(starts_at at time zone ${settings.timezone})::date`, "<=", to)
    .orderBy("starts_at")
    .execute();
  const records = sessions.length
    ? await db
        .selectFrom("attendance_records")
        .innerJoin("students", "students.id", "attendance_records.student_id")
        .select(["attendance_records.session_id as sessionId", "attendance_records.student_id as studentId", "students.first_name as firstName", "students.last_name as lastName", "attendance_records.status"])
        .where("attendance_records.session_id", "in", sessions.map((s) => s.id))
        .where("attendance_records.is_guest", "=", false)
        .execute()
    : [];
  const students = new Map<string, { studentId: string; firstName: string; lastName: string; cells: Record<string, AttendanceStatus> }>();
  for (const r of records) {
    const entry = students.get(r.studentId) ?? { studentId: r.studentId, firstName: r.firstName, lastName: r.lastName, cells: {} };
    entry.cells[r.sessionId] = r.status;
    students.set(r.studentId, entry);
  }
  const rateSettings = { countJustifiedAsPresent: settings.countJustifiedAsPresent, countOtherGroupAsPresent: settings.countOtherGroupAsPresent };
  const rows = [...students.values()]
    .sort((a, b) => a.lastName.localeCompare(b.lastName, "fr") || a.firstName.localeCompare(b.firstName, "fr"))
    .map((s) => {
      const rate = attendanceRate(Object.values(s.cells), rateSettings);
      return { ...s, rate, rateBasisPoints: rateToBasisPoints(rate) ?? null };
    });
  const groupRate = attendanceRate(records.map((r) => r.status), rateSettings);
  return { settings: rateSettings, sessions: sessions.map((s) => ({ id: s.id, startsAt: s.startsAt, localDate: s.localDate })), rows, groupRate, groupRateBasisPoints: rateToBasisPoints(groupRate) ?? null };
}
