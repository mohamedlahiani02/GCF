import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../db/types.js";
import { notFound } from "../errors.js";

type Db = Kysely<Database> | Transaction<Database>;

/** Who owes and pays: a student (enrolments) or a renter (room rentals). */
export type Payer = { kind: "student"; id: string } | { kind: "renter"; id: string };
export const studentPayer = (id: string): Payer => ({ kind: "student", id });

export type InstallmentState = "paid" | "partial" | "overdue" | "postponed" | "upcoming" | "cancelled" | "pending_discount" | "discount" | "rejected_discount";

export interface InstallmentBalance {
  id: string;
  enrolmentId: string | null;
  rentalId: string | null;
  label: string;
  kind: "charge" | "discount";
  amount: number;
  dueDate: string;
  originalDueDate: string;
  postponementCount: number;
  discountStatus: "pending" | "approved" | "rejected" | null;
  status: "open" | "cancelled";
  sessionId: string | null;
  paid: number;
  remaining: number;
  state: InstallmentState;
}

/** Serialises every money operation of one payer so balances cannot be raced. */
export async function lockPayer(trx: Transaction<Database>, payer: Payer, centreId: string): Promise<void> {
  const table = payer.kind === "student" ? "students" : "renters";
  const row = await trx.selectFrom(table).select("id").where("id", "=", payer.id).where("centre_id", "=", centreId).forUpdate().executeTakeFirst();
  if (!row) throw notFound(payer.kind);
}

export async function lockStudent(trx: Transaction<Database>, studentId: string, centreId: string): Promise<void> {
  await lockPayer(trx, studentPayer(studentId), centreId);
}

export function stateOf(row: Omit<InstallmentBalance, "state">, today: string, graceDays: number): InstallmentState {
  if (row.status === "cancelled") return "cancelled";
  if (row.kind === "discount") {
    if (row.discountStatus === "pending") return "pending_discount";
    if (row.discountStatus === "rejected") return "rejected_discount";
    return "discount";
  }
  if (row.remaining <= 0) return "paid";
  const overdueFrom = new Date(`${row.dueDate}T00:00:00Z`);
  overdueFrom.setUTCDate(overdueFrom.getUTCDate() + graceDays);
  if (overdueFrom.toISOString().slice(0, 10) < today) return "overdue";
  if (row.postponementCount > 0) return "postponed";
  if (row.paid > 0) return "partial";
  return "upcoming";
}

export async function centreClock(db: Db, centreId: string): Promise<{ today: string; graceDays: number; timezone: string }> {
  return db
    .selectFrom("centres")
    .select(["timezone", "overdue_grace_days as graceDays", sql<string>`to_char(now() at time zone timezone, 'YYYY-MM-DD')`.as("today")])
    .where("id", "=", centreId)
    .executeTakeFirstOrThrow();
}

/** Instalments with what has been paid on them, from effective allocations only. */
export async function installmentBalances(
  db: Db,
  centreId: string,
  filter: { payer?: Payer; studentId?: string; enrolmentId?: string; rentalId?: string; installmentIds?: string[] },
): Promise<InstallmentBalance[]> {
  const { today, graceDays } = await centreClock(db, centreId);
  const payer = filter.payer ?? (filter.studentId ? studentPayer(filter.studentId) : undefined);
  const paidByInstallment = db
    .selectFrom("effective_allocations")
    .select(["installment_id", sql<number>`sum(amount)::bigint`.as("paid")])
    .groupBy("installment_id")
    .as("p");
  const rows = await db
    .selectFrom("installments")
    .leftJoin("enrolments", "enrolments.id", "installments.enrolment_id")
    .leftJoin("rentals", "rentals.id", "installments.rental_id")
    .leftJoin(paidByInstallment, "p.installment_id", "installments.id")
    .select([
      "installments.id",
      "installments.enrolment_id as enrolmentId",
      "installments.rental_id as rentalId",
      "installments.label",
      "installments.kind",
      "installments.amount",
      "installments.due_date as dueDate",
      "installments.original_due_date as originalDueDate",
      "installments.postponement_count as postponementCount",
      "installments.discount_status as discountStatus",
      "installments.status",
      "installments.session_id as sessionId",
      sql<number>`coalesce(p.paid, 0)`.as("paid"),
    ])
    .where("installments.centre_id", "=", centreId)
    .$if(payer?.kind === "student", (qb) => qb.where("enrolments.student_id", "=", payer!.id))
    .$if(payer?.kind === "renter", (qb) => qb.where("rentals.renter_id", "=", payer!.id))
    .$if(filter.enrolmentId !== undefined, (qb) => qb.where("installments.enrolment_id", "=", filter.enrolmentId!))
    .$if(filter.rentalId !== undefined, (qb) => qb.where("installments.rental_id", "=", filter.rentalId!))
    .$if(filter.installmentIds !== undefined, (qb) =>
      qb.where("installments.id", "in", filter.installmentIds!.length ? filter.installmentIds! : ["00000000-0000-0000-0000-000000000000"]),
    )
    .orderBy("installments.due_date")
    .orderBy("installments.created_at")
    .execute();
  return rows.map((r) => {
    const paid = Number(r.paid);
    const remaining = r.kind === "charge" && r.status === "open" ? r.amount - paid : 0;
    const base = { ...r, paid, remaining };
    return { ...base, state: stateOf(base, today, graceDays) };
  });
}

/** Money received and not yet allocated (refunds included): the payer's credit balance. */
export async function payerCredit(db: Db, payer: Payer): Promise<number> {
  const column = payer.kind === "student" ? sql.ref("p.student_id") : sql.ref("p.renter_id");
  const result = await sql<{ credit: number }>`
    select (coalesce((select sum(p.amount) from payments p
                       where ${column} = ${payer.id} and p.status = 'valid' and coalesce(p.cheque_status, 'cashed') <> 'bounced'), 0)
          - coalesce((select sum(a.amount) from effective_allocations a join payments p on p.id = a.payment_id
                       where ${column} = ${payer.id}), 0))::bigint as credit`.execute(db);
  return Number(result.rows[0]?.credit ?? 0);
}

export async function studentCredit(db: Db, studentId: string): Promise<number> {
  return payerCredit(db, studentPayer(studentId));
}

export interface PayerTotals {
  due: number;
  credit: number;
  pendingDiscounts: number;
}

export async function payerTotals(db: Db, centreId: string, payer: Payer): Promise<PayerTotals> {
  const balances = await installmentBalances(db, centreId, { payer });
  return {
    due: balances.reduce((s, b) => s + b.remaining, 0),
    credit: await payerCredit(db, payer),
    pendingDiscounts: balances.filter((b) => b.state === "pending_discount").reduce((s, b) => s - b.amount, 0),
  };
}

export async function studentTotals(db: Db, centreId: string, studentId: string): Promise<PayerTotals> {
  return payerTotals(db, centreId, studentPayer(studentId));
}

export interface PlannedAllocation {
  installmentId: string;
  label: string;
  dueDate: string;
  amount: number;
  source: "payment" | "discount";
  sourceId: string;
}

/**
 * Plans how the payer's approved discounts and credit pay their open charges. Discounts only pay charges of
 * their own enrolment. Requested instalments are paid first, then everything else, oldest due date first.
 * `extraCredit` simulates a payment that is not saved yet (`pendingPaymentId` identifies it).
 */
export async function planAllocations(
  db: Db,
  centreId: string,
  payer: Payer,
  options: { priority?: string[]; extraCredit?: number; pendingPaymentId?: string } = {},
): Promise<PlannedAllocation[]> {
  const balances = await installmentBalances(db, centreId, { payer });
  const remaining = new Map(balances.filter((b) => b.kind === "charge" && b.status === "open" && b.remaining > 0).map((b) => [b.id, b.remaining]));
  const priority = options.priority ?? [];
  const charges = balances
    .filter((b) => remaining.has(b.id))
    .sort((a, b) => {
      const pa = priority.indexOf(a.id);
      const pb = priority.indexOf(b.id);
      if (pa !== -1 || pb !== -1) return (pa === -1 ? Infinity : pa) - (pb === -1 ? Infinity : pb);
      return a.dueDate.localeCompare(b.dueDate);
    });
  const planned: PlannedAllocation[] = [];

  if (payer.kind === "student") {
    const discountUse = await db
      .selectFrom("installments")
      .innerJoin("enrolments", "enrolments.id", "installments.enrolment_id")
      .leftJoin(
        db
          .selectFrom("allocations")
          .select(["discount_id", sql<number>`sum(amount)::bigint`.as("used")])
          .groupBy("discount_id")
          .as("u"),
        "u.discount_id",
        "installments.id",
      )
      .select(["installments.id", "installments.enrolment_id as enrolmentId", "installments.amount", sql<number>`coalesce(u.used, 0)`.as("used")])
      .where("enrolments.student_id", "=", payer.id)
      .where("installments.kind", "=", "discount")
      .where("installments.status", "=", "open")
      .where("installments.discount_status", "=", "approved")
      .orderBy("installments.created_at")
      .execute();
    for (const d of discountUse) {
      let available = -d.amount - Number(d.used);
      for (const c of charges) {
        if (available <= 0) break;
        if (c.enrolmentId !== d.enrolmentId) continue;
        const open = remaining.get(c.id) ?? 0;
        const take = Math.min(open, available);
        if (take <= 0) continue;
        planned.push({ installmentId: c.id, label: c.label, dueDate: c.dueDate, amount: take, source: "discount", sourceId: d.id });
        remaining.set(c.id, open - take);
        available -= take;
      }
    }
  }

  let credit = (await payerCredit(db, payer)) + (options.extraCredit ?? 0);
  if (credit <= 0) return planned;
  const payments = await db
    .selectFrom("payments")
    .leftJoin(
      db
        .selectFrom("allocations")
        .select(["payment_id", sql<number>`sum(amount)::bigint`.as("used")])
        .groupBy("payment_id")
        .as("u"),
      "u.payment_id",
      "payments.id",
    )
    .select(["payments.id", "payments.amount", sql<number>`coalesce(u.used, 0)`.as("used")])
    .where(payer.kind === "student" ? "payments.student_id" : "payments.renter_id", "=", payer.id)
    .where("payments.kind", "=", "payment")
    .where("payments.status", "=", "valid")
    .where(sql<boolean>`coalesce(payments.cheque_status, 'cashed') <> 'bounced'`)
    .orderBy("payments.received_at")
    .orderBy("payments.created_at")
    .execute();
  const sources = payments.map((p) => ({ id: p.id, available: p.amount - Number(p.used) }));
  if (options.extraCredit && options.pendingPaymentId) sources.push({ id: options.pendingPaymentId, available: options.extraCredit });
  for (const c of charges) {
    let open = remaining.get(c.id) ?? 0;
    for (const s of sources) {
      if (open <= 0 || credit <= 0) break;
      const take = Math.min(open, s.available, credit);
      if (take <= 0) continue;
      planned.push({ installmentId: c.id, label: c.label, dueDate: c.dueDate, amount: take, source: "payment", sourceId: s.id });
      s.available -= take;
      open -= take;
      credit -= take;
    }
    remaining.set(c.id, open);
  }
  return planned;
}

export async function applyAllocations(trx: Transaction<Database>, centreId: string, planned: PlannedAllocation[], userId: string): Promise<void> {
  if (planned.length === 0) return;
  await trx
    .insertInto("allocations")
    .values(
      planned.map((p) => ({
        centre_id: centreId,
        payment_id: p.source === "payment" ? p.sourceId : null,
        discount_id: p.source === "discount" ? p.sourceId : null,
        installment_id: p.installmentId,
        amount: p.amount,
        created_by: userId,
      })),
    )
    .execute();
}

/** Applies discounts and credit to open charges. Called whenever charges, payments or discounts change. */
export async function settlePayer(trx: Transaction<Database>, centreId: string, payer: Payer, userId: string): Promise<PlannedAllocation[]> {
  const planned = await planAllocations(trx, centreId, payer);
  await applyAllocations(trx, centreId, planned, userId);
  return planned;
}

export async function settleStudent(trx: Transaction<Database>, centreId: string, studentId: string, userId: string): Promise<PlannedAllocation[]> {
  return settlePayer(trx, centreId, studentPayer(studentId), userId);
}
