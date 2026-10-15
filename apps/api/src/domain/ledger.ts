import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../db/types.js";
import { notFound } from "../errors.js";

type Db = Kysely<Database> | Transaction<Database>;

export type InstallmentState = "paid" | "partial" | "overdue" | "postponed" | "upcoming" | "cancelled" | "pending_discount" | "discount" | "rejected_discount";

export interface InstallmentBalance {
  id: string;
  enrolmentId: string;
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

/** Serialises every money operation of one student so balances cannot be raced. */
export async function lockStudent(trx: Transaction<Database>, studentId: string, centreId: string): Promise<void> {
  const row = await trx.selectFrom("students").select("id").where("id", "=", studentId).where("centre_id", "=", centreId).forUpdate().executeTakeFirst();
  if (!row) throw notFound("student");
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
  const centre = await db
    .selectFrom("centres")
    .select(["timezone", "overdue_grace_days as graceDays", sql<string>`to_char(now() at time zone timezone, 'YYYY-MM-DD')`.as("today")])
    .where("id", "=", centreId)
    .executeTakeFirstOrThrow();
  return centre;
}

/** Instalments with what has been paid on them, from effective allocations only. */
export async function installmentBalances(db: Db, centreId: string, filter: { studentId?: string; enrolmentId?: string; installmentIds?: string[] }): Promise<InstallmentBalance[]> {
  const { today, graceDays } = await centreClock(db, centreId);
  const paidByInstallment = db
    .selectFrom("effective_allocations")
    .select(["installment_id", sql<number>`sum(amount)::bigint`.as("paid")])
    .groupBy("installment_id")
    .as("p");
  const rows = await db
    .selectFrom("installments")
    .innerJoin("enrolments", "enrolments.id", "installments.enrolment_id")
    .leftJoin(paidByInstallment, "p.installment_id", "installments.id")
    .select([
      "installments.id",
      "installments.enrolment_id as enrolmentId",
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
    .$if(filter.studentId !== undefined, (qb) => qb.where("enrolments.student_id", "=", filter.studentId!))
    .$if(filter.enrolmentId !== undefined, (qb) => qb.where("installments.enrolment_id", "=", filter.enrolmentId!))
    .$if(filter.installmentIds !== undefined, (qb) => qb.where("installments.id", "in", filter.installmentIds!.length ? filter.installmentIds! : ["00000000-0000-0000-0000-000000000000"]))
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

/** Money received and not yet allocated (refunds included): the student's credit balance. */
export async function studentCredit(db: Db, studentId: string): Promise<number> {
  const result = await sql<{ credit: number }>`
    select (coalesce((select sum(p.amount) from payments p
                       where p.student_id = ${studentId} and p.status = 'valid' and coalesce(p.cheque_status, 'cashed') <> 'bounced'), 0)
          - coalesce((select sum(a.amount) from effective_allocations a join payments p on p.id = a.payment_id
                       where p.student_id = ${studentId}), 0))::bigint as credit`.execute(db);
  return Number(result.rows[0]?.credit ?? 0);
}

export interface StudentTotals {
  due: number;
  credit: number;
  pendingDiscounts: number;
}

export async function studentTotals(db: Db, centreId: string, studentId: string): Promise<StudentTotals> {
  const balances = await installmentBalances(db, centreId, { studentId });
  return {
    due: balances.reduce((s, b) => s + b.remaining, 0),
    credit: await studentCredit(db, studentId),
    pendingDiscounts: balances.filter((b) => b.state === "pending_discount").reduce((s, b) => s - b.amount, 0),
  };
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
 * Plans how the student's approved discounts and credit pay their open charges. Discounts only pay charges of
 * their own enrolment. Requested instalments are paid first, then everything else, oldest due date first.
 * `extraCredit` simulates a payment that is not saved yet (`pendingPaymentId` identifies it).
 */
export async function planAllocations(
  db: Db,
  centreId: string,
  studentId: string,
  options: { priority?: string[]; extraCredit?: number; pendingPaymentId?: string } = {},
): Promise<PlannedAllocation[]> {
  const balances = await installmentBalances(db, centreId, { studentId });
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

  const discountUse = await db
    .selectFrom("installments")
    .innerJoin("enrolments", "enrolments.id", "installments.enrolment_id")
    .leftJoin(db.selectFrom("allocations").select(["discount_id", sql<number>`sum(amount)::bigint`.as("used")]).groupBy("discount_id").as("u"), "u.discount_id", "installments.id")
    .select(["installments.id", "installments.enrolment_id as enrolmentId", "installments.amount", sql<number>`coalesce(u.used, 0)`.as("used")])
    .where("enrolments.student_id", "=", studentId)
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

  let credit = (await studentCredit(db, studentId)) + (options.extraCredit ?? 0);
  if (credit <= 0) return planned;
  const payments = await db
    .selectFrom("payments")
    .leftJoin(db.selectFrom("allocations").select(["payment_id", sql<number>`sum(amount)::bigint`.as("used")]).groupBy("payment_id").as("u"), "u.payment_id", "payments.id")
    .select(["payments.id", "payments.amount", sql<number>`coalesce(u.used, 0)`.as("used")])
    .where("payments.student_id", "=", studentId)
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
export async function settleStudent(trx: Transaction<Database>, centreId: string, studentId: string, userId: string): Promise<PlannedAllocation[]> {
  const planned = await planAllocations(trx, centreId, studentId);
  await applyAllocations(trx, centreId, planned, userId);
  return planned;
}
