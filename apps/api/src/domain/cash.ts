import { sql, type Kysely, type Transaction } from "kysely";
import { writeAudit } from "../audit.js";
import type { Database, PaymentMethod, Till } from "../db/types.js";
import { conflict, unprocessable } from "../errors.js";
import { centreClock } from "./ledger.js";

type Db = Kysely<Database> | Transaction<Database>;

/** Once today's cash is closed, no money movement may change it. */
export async function assertCashOpen(db: Db, centreId: string): Promise<void> {
  const { today } = await centreClock(db, centreId);
  const closed = await db.selectFrom("cash_closings").select("id").where("centre_id", "=", centreId).where("day", "=", today).executeTakeFirst();
  if (closed) throw conflict("cash_closed", "today's cash is closed; money movements resume tomorrow");
}

/** The activity a payment belongs to follows its payer: students train, renters rent rooms, members cowork. */
export type CashActivity = "training" | "rental" | "coworking";

export interface CashDay {
  day: string;
  payments: {
    id: string;
    receivedAt: Date;
    payerName: string;
    activity: CashActivity;
    method: PaymentMethod;
    amount: number;
    status: "valid" | "cancelled";
    kind: "payment" | "refund";
    receiptNumber: string | null;
    createdBy: string | null;
  }[];
  totals: Record<PaymentMethod, number>;
  byActivity: Record<CashActivity, Record<PaymentMethod, number>>;
  /** The cash put in the till that morning; the closing expects it on top of the cash received. */
  openingFloat: number;
  expectedCash: number;
}

/** Money received on a local day; cancelled payments are listed but never counted. */
export async function cashDay(db: Db, centreId: string, day: string, openingFloat: number): Promise<CashDay> {
  const { timezone } = await centreClock(db, centreId);
  const payments = await db
    .selectFrom("payments")
    .leftJoin("students", "students.id", "payments.student_id")
    .leftJoin("renters", "renters.id", "payments.renter_id")
    .leftJoin("members", "members.id", "payments.member_id")
    .leftJoin("users", "users.id", "payments.created_by")
    .leftJoin("receipts", (join) => join.onRef("receipts.payment_id", "=", "payments.id").on("receipts.kind", "!=", "cancellation"))
    .select([
      "payments.id",
      "payments.received_at as receivedAt",
      sql<string>`coalesce(students.first_name || ' ' || students.last_name, renters.name, concat_ws(' ', members.first_name, members.last_name))`.as(
        "payerName",
      ),
      sql<CashActivity>`case when payments.student_id is not null then 'training' when payments.renter_id is not null then 'rental' else 'coworking' end`.as(
        "activity",
      ),
      "payments.method",
      "payments.amount",
      "payments.status",
      "payments.kind",
      "receipts.number as receiptNumber",
      "users.full_name as createdBy",
    ])
    .where("payments.centre_id", "=", centreId)
    .where(sql<string>`(payments.received_at at time zone ${timezone})::date`, "=", day)
    .orderBy("payments.received_at")
    .execute();
  const empty = (): Record<PaymentMethod, number> => ({ cash: 0, cheque: 0, card: 0, transfer: 0 });
  const totals = empty();
  const byActivity: Record<CashActivity, Record<PaymentMethod, number>> = { training: empty(), rental: empty(), coworking: empty() };
  for (const p of payments) {
    if (p.status !== "valid") continue;
    totals[p.method] += p.amount;
    byActivity[p.activity][p.method] += p.amount;
  }
  return { day, payments, totals, byActivity, openingFloat, expectedCash: openingFloat + totals.cash };
}

/**
 * Serialises one till of a centre for the rest of the transaction, so its opening float cannot change while
 * its day is being closed.
 */
export async function lockTill(trx: Transaction<Database>, centreId: string, till: Till): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`${till}-till:${centreId}`}, 0))`.execute(trx);
}

export interface OpeningFloat {
  amount: number;
  /** False while nobody entered this morning's float: the amount is then the fallback of the till. */
  recorded: boolean;
  /** What the entry form proposes: the last float entered for this till, or its fallback. */
  suggested: number;
}

/** The opening float of a till on a day. Without an entry, the till's fallback applies (the café's setting, else nothing). */
export async function openingFloat(db: Db, centreId: string, till: Till, day: string, fallback: number): Promise<OpeningFloat> {
  const entry = await db
    .selectFrom("cash_openings")
    .select("amount")
    .where("centre_id", "=", centreId)
    .where("till", "=", till)
    .where("day", "=", day)
    .executeTakeFirst();
  const last = await db
    .selectFrom("cash_openings")
    .select("amount")
    .where("centre_id", "=", centreId)
    .where("till", "=", till)
    .where("day", "<", day)
    .orderBy("day", "desc")
    .executeTakeFirst();
  return { amount: entry ? entry.amount : fallback, recorded: entry !== undefined, suggested: entry?.amount ?? last?.amount ?? fallback };
}

/**
 * Enters or corrects the float of a day that is not closed yet. The caller holds the till lock and has checked
 * that the day is open.
 */
export async function setOpeningFloat(
  trx: Transaction<Database>,
  input: { centreId: string; till: Till; day: string; amount: number; userId: string; today: string; fallback: number },
): Promise<{ till: Till; day: string; amount: number }> {
  if (input.day > input.today) throw unprocessable("future_day", "a float is entered for a day that has started");
  const before = await openingFloat(trx, input.centreId, input.till, input.day, input.fallback);
  const row = await trx
    .insertInto("cash_openings")
    .values({ centre_id: input.centreId, till: input.till, day: input.day, amount: input.amount, opened_by: input.userId })
    .onConflict((oc) => oc.columns(["centre_id", "till", "day"]).doUpdateSet({ amount: input.amount, opened_by: input.userId, updated_at: new Date() }))
    .returning("id")
    .executeTakeFirstOrThrow();
  await writeAudit(trx, {
    centreId: input.centreId,
    userId: input.userId,
    action: "cash.opening_set",
    objectType: "cash_opening",
    objectId: row.id,
    before: before.recorded ? { amount: before.amount } : undefined,
    after: { till: input.till, day: input.day, amount: input.amount },
  });
  return { till: input.till, day: input.day, amount: input.amount };
}
