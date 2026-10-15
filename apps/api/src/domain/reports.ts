import { addDays, isoWeekday, mulDivRound } from "@gcf/shared";
import { sql, type Kysely } from "kysely";
import type { Database } from "../db/types.js";
import { groupAttendance } from "./attendance.js";
import { centreClock, stateOf } from "./ledger.js";
import type { ReportTable } from "./tableExport.js";

type Db = Kysely<Database>;

export interface ReportRange {
  from: string;
  to: string;
}

export type ReportName = "unpaid" | "revenue" | "collections" | "payroll" | "attendance" | "rooms";
export type Audience = "operational" | "financial";

export const REPORTS: Record<ReportName, { title: string; audiences: Audience[] }> = {
  unpaid: { title: "Impayés et échéances reportées", audiences: ["operational", "financial"] },
  revenue: { title: "Chiffre d'affaires par formation, étude et location", audiences: ["financial"] },
  collections: { title: "Encaissements par mode et par utilisateur", audiences: ["financial"] },
  payroll: { title: "Paie par intervenant", audiences: ["financial"] },
  attendance: { title: "Taux de présence par groupe", audiences: ["operational", "financial"] },
  rooms: { title: "Occupation et revenus des salles", audiences: ["operational", "financial"] },
};

const subtitle = (range: ReportRange) => `Du ${range.from.split("-").reverse().join("/")} au ${range.to.split("-").reverse().join("/")}`;

async function unpaid(db: Db, centreId: string, range: ReportRange): Promise<ReportTable> {
  const { today, graceDays } = await centreClock(db, centreId);
  const rows = await db
    .selectFrom("installments")
    .leftJoin("enrolments", "enrolments.id", "installments.enrolment_id")
    .leftJoin("students", "students.id", "enrolments.student_id")
    .leftJoin("rentals", "rentals.id", "installments.rental_id")
    .leftJoin("renters", "renters.id", "rentals.renter_id")
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
      "installments.id",
      sql<string>`coalesce(students.last_name || ' ' || students.first_name, renters.name)`.as("payer"),
      "installments.label",
      "installments.amount",
      "installments.due_date as dueDate",
      "installments.original_due_date as originalDueDate",
      "installments.postponement_count as postponementCount",
      sql<number>`coalesce(p.paid, 0)`.as("paid"),
    ])
    .where("installments.centre_id", "=", centreId)
    .where("installments.kind", "=", "charge")
    .where("installments.status", "=", "open")
    .where("installments.due_date", ">=", range.from)
    .where("installments.due_date", "<=", range.to)
    .where(sql<boolean>`installments.amount > coalesce(p.paid, 0)`)
    .orderBy("installments.due_date")
    .execute();
  const filtered = rows
    .map((r) => {
      const paid = Number(r.paid);
      const state = stateOf(
        { ...r, enrolmentId: null, rentalId: null, kind: "charge", discountStatus: null, status: "open", sessionId: null, paid, remaining: r.amount - paid },
        today,
        graceDays,
      );
      return { ...r, paid, remaining: r.amount - paid, state };
    })
    .filter((r) => r.state === "overdue" || r.state === "postponed");
  return {
    title: REPORTS.unpaid.title,
    subtitle: `Échéances du ${range.from.split("-").reverse().join("/")} au ${range.to.split("-").reverse().join("/")}, situation au ${today.split("-").reverse().join("/")}`,
    columns: [
      { key: "payer", label: "Élève ou loueur", kind: "text" },
      { key: "label", label: "Objet", kind: "text" },
      { key: "dueDate", label: "Échéance", kind: "date" },
      { key: "originalDueDate", label: "Date d'origine", kind: "date" },
      { key: "status", label: "Statut", kind: "text" },
      { key: "remaining", label: "Reste dû (TND)", kind: "money" },
    ],
    rows: filtered.map((r) => ({
      payer: r.payer,
      label: r.label,
      dueDate: r.dueDate,
      originalDueDate: r.originalDueDate,
      status: r.state === "overdue" ? "En retard" : "Reporté",
      remaining: r.remaining,
    })),
  };
}

async function revenue(db: Db, centreId: string, range: ReportRange): Promise<ReportTable> {
  const { timezone } = await centreClock(db, centreId);
  const offer = sql<string>`coalesce('Étude : ' || studies.name, 'Formation : ' || trainings.title, 'Location : ' || rooms.name)`;
  const base = db
    .selectFrom("installments")
    .leftJoin("enrolments", "enrolments.id", "installments.enrolment_id")
    .leftJoin("groups", "groups.id", "enrolments.group_id")
    .leftJoin("studies", "studies.id", "groups.study_id")
    .leftJoin("training_sessions", "training_sessions.id", "groups.training_session_id")
    .leftJoin("trainings", "trainings.id", "training_sessions.training_id")
    .leftJoin("rentals", "rentals.id", "installments.rental_id")
    .leftJoin("rooms", "rooms.id", "rentals.room_id");
  const invoiced = await base
    .select([offer.as("offer"), sql<number>`sum(installments.amount)::bigint`.as("total")])
    .where("installments.centre_id", "=", centreId)
    .where("installments.status", "=", "open")
    .where((eb) => eb.or([eb("installments.kind", "=", "charge"), eb("installments.discount_status", "=", "approved")]))
    .where("installments.due_date", ">=", range.from)
    .where("installments.due_date", "<=", range.to)
    .groupBy(offer)
    .execute();
  const collected = await base
    .innerJoin("effective_allocations", "effective_allocations.installment_id", "installments.id")
    .innerJoin("payments", "payments.id", "effective_allocations.payment_id")
    .select([offer.as("offer"), sql<number>`sum(effective_allocations.amount)::bigint`.as("total")])
    .where("installments.centre_id", "=", centreId)
    .where(sql<string>`(payments.received_at at time zone ${timezone})::date`, ">=", range.from)
    .where(sql<string>`(payments.received_at at time zone ${timezone})::date`, "<=", range.to)
    .groupBy(offer)
    .execute();
  const offers = [...new Set([...invoiced.map((r) => r.offer), ...collected.map((r) => r.offer)])].sort((a, b) => a.localeCompare(b, "fr"));
  return {
    title: REPORTS.revenue.title,
    subtitle: `${subtitle(range)}. Facturé : échéances de la période, remises approuvées déduites. Encaissé : paiements reçus sur la période.`,
    columns: [
      { key: "offer", label: "Offre", kind: "text" },
      { key: "invoiced", label: "Facturé (TND)", kind: "money" },
      { key: "collected", label: "Encaissé (TND)", kind: "money" },
    ],
    rows: offers.map((offerName) => ({
      offer: offerName,
      invoiced: Number(invoiced.find((r) => r.offer === offerName)?.total ?? 0),
      collected: Number(collected.find((r) => r.offer === offerName)?.total ?? 0),
    })),
  };
}

async function collections(db: Db, centreId: string, range: ReportRange): Promise<ReportTable> {
  const { timezone } = await centreClock(db, centreId);
  const rows = await db
    .selectFrom("payments")
    .leftJoin("users", "users.id", "payments.created_by")
    .select(["payments.method", "users.full_name as user", sql<number>`count(*)::integer`.as("count"), sql<number>`sum(payments.amount)::bigint`.as("total")])
    .where("payments.centre_id", "=", centreId)
    .where("payments.status", "=", "valid")
    .where(sql<boolean>`coalesce(payments.cheque_status, 'cashed') <> 'bounced'`)
    .where(sql<string>`(payments.received_at at time zone ${timezone})::date`, ">=", range.from)
    .where(sql<string>`(payments.received_at at time zone ${timezone})::date`, "<=", range.to)
    .groupBy(["payments.method", "users.full_name"])
    .orderBy("payments.method")
    .orderBy("users.full_name")
    .execute();
  const methods = { cash: "Espèces", transfer: "Virement", cheque: "Chèque", card: "Carte" } as const;
  return {
    title: REPORTS.collections.title,
    subtitle: `${subtitle(range)}. Paiements valides, chèques impayés exclus, remboursements déduits.`,
    columns: [
      { key: "method", label: "Mode", kind: "text" },
      { key: "user", label: "Utilisateur", kind: "text" },
      { key: "count", label: "Opérations", kind: "number" },
      { key: "total", label: "Montant (TND)", kind: "money" },
    ],
    rows: rows.map((r) => ({ method: methods[r.method], user: r.user ?? "", count: r.count, total: Number(r.total) })),
  };
}

async function payroll(db: Db, centreId: string, range: ReportRange): Promise<ReportTable> {
  const rows = await db
    .selectFrom("payslips")
    .innerJoin("pay_periods", "pay_periods.id", "payslips.period_id")
    .innerJoin("instructors", "instructors.id", "payslips.instructor_id")
    .select(["instructors.last_name as lastName", "instructors.first_name as firstName", "pay_periods.month", "payslips.total", "payslips.paid_on as paidOn"])
    .where("pay_periods.centre_id", "=", centreId)
    .where("pay_periods.month", ">=", `${range.from.slice(0, 7)}-01`)
    .where("pay_periods.month", "<=", range.to)
    .orderBy("instructors.last_name")
    .orderBy("pay_periods.month")
    .execute();
  return {
    title: REPORTS.payroll.title,
    subtitle: `${subtitle(range)}. Périodes validées.`,
    columns: [
      { key: "instructor", label: "Intervenant", kind: "text" },
      { key: "month", label: "Période", kind: "text" },
      { key: "total", label: "Net (TND)", kind: "money" },
      { key: "paidOn", label: "Payé le", kind: "date" },
    ],
    rows: rows.map((r) => ({ instructor: `${r.lastName} ${r.firstName}`, month: r.month.slice(0, 7), total: r.total, paidOn: r.paidOn })),
  };
}

async function attendance(db: Db, centreId: string, range: ReportRange): Promise<ReportTable> {
  const groups = await db.selectFrom("groups").select(["id", "name"]).where("centre_id", "=", centreId).orderBy("name").execute();
  const rows: ReportTable["rows"] = [];
  for (const g of groups) {
    const result = await groupAttendance(db, g.id, centreId, range.from, range.to);
    if (result.sessions.length === 0) continue;
    rows.push({
      group: g.name,
      sessions: result.sessions.length,
      counted: result.groupRate.numerator,
      expected: result.groupRate.denominator,
      rate: result.groupRateBasisPoints,
    });
  }
  return {
    title: REPORTS.attendance.title,
    subtitle: `${subtitle(range)}. Feuilles validées ; réglages de comptage propres à chaque groupe.`,
    columns: [
      { key: "group", label: "Groupe", kind: "text" },
      { key: "sessions", label: "Séances", kind: "number" },
      { key: "counted", label: "Présences comptées", kind: "number" },
      { key: "expected", label: "Présences attendues", kind: "number" },
      { key: "rate", label: "Taux", kind: "percent" },
    ],
    rows,
  };
}

/** Minutes the centre is open between two dates, from its opening hours and days. */
export async function openMinutes(db: Db, centreId: string, range: ReportRange): Promise<number> {
  const centre = await db.selectFrom("centres").select(["open_from", "open_to", "open_weekdays"]).where("id", "=", centreId).executeTakeFirstOrThrow();
  const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const daily = toMinutes(centre.open_to) - toMinutes(centre.open_from);
  let days = 0;
  for (let d = range.from, guard = 0; d <= range.to && guard < 1000; d = addDays(d, 1), guard += 1) if (centre.open_weekdays.includes(isoWeekday(d))) days += 1;
  return days * daily;
}

async function rooms(db: Db, centreId: string, range: ReportRange): Promise<ReportTable> {
  const { timezone } = await centreClock(db, centreId);
  const available = await openMinutes(db, centreId, range);
  const minutes = await db
    .selectFrom("room_bookings")
    .leftJoin("rental_slots", "rental_slots.id", "room_bookings.rental_slot_id")
    .select([
      "room_bookings.room_id as roomId",
      sql<string>`case when room_bookings.session_id is not null then 'course' else 'rental' end`.as("source"),
      sql<number>`sum(extract(epoch from upper(period) - lower(period)) / 60)::bigint`.as("minutes"),
    ])
    .where("room_bookings.centre_id", "=", centreId)
    .where("room_bookings.active", "=", true)
    .where(sql<string>`(lower(room_bookings.period) at time zone ${timezone})::date`, ">=", range.from)
    .where(sql<string>`(lower(room_bookings.period) at time zone ${timezone})::date`, "<=", range.to)
    .groupBy(["room_bookings.room_id", sql`case when room_bookings.session_id is not null then 'course' else 'rental' end`])
    .execute();
  const revenue = await db
    .selectFrom("installments")
    .innerJoin("rentals", "rentals.id", "installments.rental_id")
    .select(["rentals.room_id as roomId", sql<number>`sum(installments.amount)::bigint`.as("invoiced")])
    .where("installments.centre_id", "=", centreId)
    .where("installments.status", "=", "open")
    .where("installments.due_date", ">=", range.from)
    .where("installments.due_date", "<=", range.to)
    .groupBy("rentals.room_id")
    .execute();
  const roomList = await db
    .selectFrom("rooms")
    .select(["id", "name"])
    .where("centre_id", "=", centreId)
    .where("status", "=", "active")
    .orderBy("name")
    .execute();
  return {
    title: REPORTS.rooms.title,
    subtitle: `${subtitle(range)}. Occupation calculée sur les horaires d'ouverture du centre.`,
    columns: [
      { key: "room", label: "Salle", kind: "text" },
      { key: "courseHours", label: "Heures de cours", kind: "number" },
      { key: "rentalHours", label: "Heures louées", kind: "number" },
      { key: "occupancy", label: "Occupation", kind: "percent" },
      { key: "rentalRevenue", label: "Revenus de location facturés (TND)", kind: "money" },
    ],
    rows: roomList.map((room) => {
      const course = Number(minutes.find((m) => m.roomId === room.id && m.source === "course")?.minutes ?? 0);
      const rental = Number(minutes.find((m) => m.roomId === room.id && m.source === "rental")?.minutes ?? 0);
      return {
        room: room.name,
        courseHours: Math.round((course / 60) * 10) / 10,
        rentalHours: Math.round((rental / 60) * 10) / 10,
        occupancy: available > 0 ? mulDivRound(10_000, course + rental, available) : null,
        rentalRevenue: Number(revenue.find((r) => r.roomId === room.id)?.invoiced ?? 0),
      };
    }),
  };
}

export async function buildReport(db: Db, name: ReportName, centreId: string, range: ReportRange): Promise<ReportTable> {
  switch (name) {
    case "unpaid":
      return unpaid(db, centreId, range);
    case "revenue":
      return revenue(db, centreId, range);
    case "collections":
      return collections(db, centreId, range);
    case "payroll":
      return payroll(db, centreId, range);
    case "attendance":
      return attendance(db, centreId, range);
    case "rooms":
      return rooms(db, centreId, range);
  }
}
