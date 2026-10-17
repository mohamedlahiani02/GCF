import { createHash } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { Database } from "../db/types.js";
import { centreClock, payerCredit, payerTotals, type Payer } from "./ledger.js";
import { renderReceipt, type ReceiptSnapshot } from "./receiptPdf.js";

/** Gap-free numbering per centre and year: the counter row is locked and rolls back with the transaction. */
async function nextNumber(trx: Transaction<Database>, centreId: string, year: number): Promise<number> {
  const row = await trx
    .insertInto("receipt_counters")
    .values({ centre_id: centreId, year, last_number: 1 })
    .onConflict((oc) => oc.columns(["centre_id", "year"]).doUpdateSet({ last_number: sql<number>`receipt_counters.last_number + 1` }))
    .returning("last_number")
    .executeTakeFirstOrThrow();
  return row.last_number;
}

export interface IssueReceipt {
  centreId: string;
  paymentId: string;
  kind: ReceiptSnapshot["kind"];
  lines: { label: string; amount: number }[];
  cancels?: { receiptId: string; number: string; reason: string };
  userId: string;
}

export async function issueReceipt(trx: Transaction<Database>, input: IssueReceipt): Promise<{ id: string; number: string }> {
  const payment = await trx
    .selectFrom("payments")
    .leftJoin("students", "students.id", "payments.student_id")
    .leftJoin("renters", "renters.id", "payments.renter_id")
    .leftJoin("members", "members.id", "payments.member_id")
    .leftJoin("companies", "companies.id", "members.company_id")
    .innerJoin("centres", "centres.id", "payments.centre_id")
    .select([
      "payments.amount",
      "payments.method",
      "payments.cheque_number as chequeNumber",
      "payments.cheque_bank as chequeBank",
      "payments.reference",
      "payments.student_id as studentId",
      "payments.renter_id as renterId",
      "payments.member_id as memberId",
      "members.first_name as memberFirstName",
      "members.last_name as memberLastName",
      "companies.name as memberCompany",
      "renters.name as renterName",
      "renters.company as renterCompany",
      "students.first_name as firstName",
      "students.last_name as lastName",
      "students.is_minor as isMinor",
      "students.guardian_name as guardianName",
      "centres.name as centreName",
      "centres.address",
      "centres.tax_id as taxId",
      "centres.receipt_prefix as prefix",
      "centres.receipt_footer as footer",
      "centres.timezone",
    ])
    .where("payments.id", "=", input.paymentId)
    .executeTakeFirstOrThrow();
  const clock = await centreClock(trx, input.centreId);
  const year = Number(clock.today.slice(0, 4));
  const sequence = await nextNumber(trx, input.centreId, year);
  const number = `${payment.prefix}-${year}-${String(sequence).padStart(6, "0")}`;
  const issuedAt = await sql<{ at: string }>`select to_char(now() at time zone ${payment.timezone}, 'DD/MM/YYYY HH24:MI') as at`.execute(trx);
  const payer: Payer = payment.studentId
    ? { kind: "student", id: payment.studentId }
    : payment.memberId
      ? { kind: "member", id: payment.memberId }
      : { kind: "renter", id: payment.renterId! };
  const totals = await payerTotals(trx, input.centreId, payer);
  const payerName = payment.studentId
    ? `${payment.firstName} ${payment.lastName}`
    : payment.memberId
      ? `${[payment.memberFirstName, payment.memberLastName].filter(Boolean).join(" ")}${payment.memberCompany ? ` (${payment.memberCompany})` : ""}`
      : `${payment.renterName}${payment.renterCompany ? ` (${payment.renterCompany})` : ""}`;
  const snapshot: ReceiptSnapshot = {
    number,
    kind: input.kind,
    issuedAt: issuedAt.rows[0]!.at,
    centre: { name: payment.centreName, address: payment.address, taxId: payment.taxId, footer: payment.footer },
    payer: { name: payerName, guardianName: payment.isMinor ? payment.guardianName : null },
    method: payment.method,
    chequeNumber: payment.chequeNumber,
    chequeBank: payment.chequeBank,
    reference: payment.reference,
    amount: input.kind === "cancellation" ? -payment.amount : payment.amount,
    lines: input.lines,
    creditAfter: await payerCredit(trx, payer),
    remainingAfter: totals.due,
    cancels: input.cancels ? { number: input.cancels.number, reason: input.cancels.reason } : null,
  };
  const pdf = await renderReceipt(snapshot, { format: "A4", duplicate: false });
  const row = await trx
    .insertInto("receipts")
    .values({
      centre_id: input.centreId,
      number,
      year,
      sequence,
      kind: input.kind,
      payment_id: input.paymentId,
      cancels_receipt_id: input.cancels?.receiptId ?? null,
      snapshot: JSON.stringify(snapshot),
      pdf,
      sha256: createHash("sha256").update(pdf).digest("hex"),
      created_by: input.userId,
    })
    .returning(["id", "number"])
    .executeTakeFirstOrThrow();
  return row;
}
