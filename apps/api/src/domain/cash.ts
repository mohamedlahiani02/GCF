import { sql, type Kysely, type Transaction } from "kysely";
import type { Database, PaymentMethod } from "../db/types.js";
import { conflict } from "../errors.js";
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
  expectedCash: number;
}

/** Money received on a local day; cancelled payments are listed but never counted. */
export async function cashDay(db: Db, centreId: string, day: string): Promise<CashDay> {
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
  return { day, payments, totals, byActivity, expectedCash: totals.cash };
}
