import { addDays, formatTnd } from "@gcf/shared";
import type { FastifyBaseLogger } from "fastify";
import { createHash } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { writeAudit } from "../audit.js";
import type { Database, InvoiceKind } from "../db/types.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import type { Mailer } from "../mail.js";
import { taxIncluded } from "./coworking/pricing.js";
import { renderInvoice, type InvoiceSnapshot } from "./invoicePdf.js";
import { centreClock, installmentBalances, lockPayer, type InstallmentBalance, type Payer } from "./ledger.js";

type Db = Kysely<Database> | Transaction<Database>;

export type InvoiceState = "credited" | "paid" | "partial" | "overdue" | "unpaid" | "credit_note";

const frenchDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const payerColumn = { student: "student_id", renter: "renter_id", member: "member_id" } as const;

/** Gap-free numbering per centre, kind and year: the counter row is locked and rolls back with the transaction. */
async function nextSequence(trx: Transaction<Database>, centreId: string, kind: InvoiceKind, year: number): Promise<number> {
  const row = await trx
    .insertInto("invoice_counters")
    .values({ centre_id: centreId, kind, year, last_number: 1 })
    .onConflict((oc) => oc.columns(["centre_id", "kind", "year"]).doUpdateSet({ last_number: sql<number>`invoice_counters.last_number + 1` }))
    .returning("last_number")
    .executeTakeFirstOrThrow();
  return row.last_number;
}

/** Who the invoice is made out to. A member of a company is invoiced to the company. */
async function buyerOf(db: Db, centreId: string, payer: Payer): Promise<InvoiceSnapshot["buyer"]> {
  if (payer.kind === "student") {
    const s = await db
      .selectFrom("students")
      .select(["first_name", "last_name", "email", "receipt_email", "is_minor", "guardian_name", "guardian_email"])
      .where("id", "=", payer.id)
      .where("centre_id", "=", centreId)
      .executeTakeFirst();
    if (!s) throw notFound("student");
    const name = `${s.first_name} ${s.last_name}`;
    return {
      name: s.is_minor && s.guardian_name ? `${s.guardian_name}, pour ${name}` : name,
      company: false,
      taxId: null,
      address: null,
      email: s.receipt_email ?? (s.is_minor ? s.guardian_email : s.email) ?? s.email,
    };
  }
  if (payer.kind === "renter") {
    const r = await db
      .selectFrom("renters")
      .select(["name", "company", "email"])
      .where("id", "=", payer.id)
      .where("centre_id", "=", centreId)
      .executeTakeFirst();
    if (!r) throw notFound("renter");
    return { name: r.company ? `${r.company} (${r.name})` : r.name, company: !!r.company, taxId: null, address: null, email: r.email };
  }
  const m = await db
    .selectFrom("members as m")
    .leftJoin("companies as c", "c.id", "m.company_id")
    .select([
      "m.first_name",
      "m.last_name",
      "m.email",
      "c.id as companyId",
      "c.name as companyName",
      "c.tax_id as taxId",
      "c.address",
      "c.email as companyEmail",
    ])
    .where("m.id", "=", payer.id)
    .where("m.centre_id", "=", centreId)
    .executeTakeFirst();
  if (!m) throw notFound("member");
  const person = [m.first_name, m.last_name].filter(Boolean).join(" ");
  if (m.companyId) return { name: m.companyName!, company: true, taxId: m.taxId, address: m.address, email: m.companyEmail ?? m.email };
  return { name: person, company: false, taxId: null, address: null, email: m.email };
}

async function centreOf(db: Db, centreId: string) {
  return db
    .selectFrom("centres")
    .select(["name", "address", "tax_id", "invoice_prefix", "credit_note_prefix", "invoice_tax_bp", "invoice_due_days", "invoice_footer"])
    .where("id", "=", centreId)
    .executeTakeFirstOrThrow();
}

/** Open charges of a payer that are on no invoice still standing: what can be invoiced now. */
export async function uninvoicedCharges(db: Db, centreId: string, payer: Payer): Promise<InstallmentBalance[]> {
  const charges = (await installmentBalances(db, centreId, { payer })).filter((c) => c.kind === "charge" && c.status === "open");
  if (charges.length === 0) return [];
  const invoiced = await db
    .selectFrom("invoice_items")
    .select("installment_id")
    .where("active", "=", true)
    .where(
      "installment_id",
      "in",
      charges.map((c) => c.id),
    )
    .execute();
  const taken = new Set(invoiced.map((i) => i.installment_id));
  return charges.filter((c) => !taken.has(c.id));
}

export interface IssueInvoice {
  centreId: string;
  payer: Payer;
  installmentIds: string[];
  userId: string;
}

/**
 * Issues an invoice for open charges of one payer. Each charge must belong to the payer and be on no invoice that
 * still stands; the payer row is locked so two invoices cannot take the same charge. Prices include tax; when the
 * buyer is a company and the centre shows a rate, the totals are split into net and tax.
 */
export async function issueInvoice(trx: Transaction<Database>, input: IssueInvoice): Promise<{ id: string; number: string }> {
  if (input.installmentIds.length === 0) throw unprocessable("invoice_empty", "choose at least one charge to invoice");
  if (new Set(input.installmentIds).size !== input.installmentIds.length) throw unprocessable("invoice_charge_repeated", "a charge is listed twice");
  await lockPayer(trx, input.payer, input.centreId);
  const available = await uninvoicedCharges(trx, input.centreId, input.payer);
  const chosen = input.installmentIds.map((id) => available.find((c) => c.id === id));
  if (chosen.some((c) => c === undefined)) {
    throw conflict("invoice_charge_unavailable", "a charge does not belong to this payer, is cancelled or is already invoiced");
  }
  const charges = chosen as InstallmentBalance[];
  const centre = await centreOf(trx, input.centreId);
  const buyer = await buyerOf(trx, input.centreId, input.payer);
  const { today } = await centreClock(trx, input.centreId);
  const year = Number(today.slice(0, 4));
  const sequence = await nextSequence(trx, input.centreId, "invoice", year);
  const number = `${centre.invoice_prefix}-${year}-${String(sequence).padStart(5, "0")}`;
  const total = charges.reduce((sum, c) => sum + c.amount, 0);
  const taxBp = buyer.company ? centre.invoice_tax_bp : null;
  const split = taxBp ? taxIncluded(total, taxBp) : { net: total, tax: 0 };
  const dueDate = addDays(today, centre.invoice_due_days);
  const snapshot: InvoiceSnapshot = {
    kind: "invoice",
    number,
    issueDate: frenchDate(today),
    dueDate: frenchDate(dueDate),
    centre: { name: centre.name, address: centre.address, taxId: centre.tax_id, footer: centre.invoice_footer },
    buyer,
    lines: charges.map((c) => ({ label: c.label, amount: c.amount })),
    total,
    net: split.net,
    tax: split.tax,
    taxBp,
    credits: null,
  };
  const pdf = await renderInvoice(snapshot);
  const row = await trx
    .insertInto("invoices")
    .values({
      centre_id: input.centreId,
      kind: "invoice",
      number,
      year,
      sequence,
      [payerColumn[input.payer.kind]]: input.payer.id,
      issue_date: today,
      due_date: dueDate,
      snapshot: JSON.stringify(snapshot),
      total,
      net: split.net,
      tax: split.tax,
      tax_bp: taxBp,
      pdf,
      sha256: createHash("sha256").update(pdf).digest("hex"),
      created_by: input.userId,
    })
    .returning(["id", "number"])
    .executeTakeFirstOrThrow();
  await trx
    .insertInto("invoice_items")
    .values(charges.map((c) => ({ invoice_id: row.id, installment_id: c.id, amount: c.amount })))
    .execute();
  await writeAudit(trx, {
    centreId: input.centreId,
    userId: input.userId,
    action: "invoice.issued",
    objectType: "invoice",
    objectId: row.id,
    after: { number, payer: input.payer, total, net: split.net, tax: split.tax, installmentIds: input.installmentIds },
  });
  return row;
}

/**
 * Cancels an invoice in full with a credit note of the opposite amount. The invoice keeps its number and PDF and is
 * marked credited; its charges are freed so they can be invoiced again. Payments already received are not touched:
 * they stay allocated to the charges in the ledger.
 */
export async function creditInvoice(
  trx: Transaction<Database>,
  input: { centreId: string; invoiceId: string; reason: string; userId: string },
): Promise<{ id: string; number: string }> {
  const invoice = await trx
    .selectFrom("invoices")
    .select(["id", "kind", "status", "number", "snapshot", "total", "net", "tax", "tax_bp", "student_id", "renter_id", "member_id"])
    .where("id", "=", input.invoiceId)
    .where("centre_id", "=", input.centreId)
    .forUpdate()
    .executeTakeFirst();
  if (!invoice) throw notFound("invoice");
  if (invoice.kind !== "invoice") throw conflict("invoice_is_credit_note", "a credit note cannot be credited");
  if (invoice.status === "credited") throw conflict("invoice_already_credited", "this invoice is already cancelled by a credit note");
  const original = invoice.snapshot as InvoiceSnapshot;
  const centre = await centreOf(trx, input.centreId);
  const { today } = await centreClock(trx, input.centreId);
  const year = Number(today.slice(0, 4));
  const sequence = await nextSequence(trx, input.centreId, "credit_note", year);
  const number = `${centre.credit_note_prefix}-${year}-${String(sequence).padStart(5, "0")}`;
  const snapshot: InvoiceSnapshot = {
    ...original,
    kind: "credit_note",
    number,
    issueDate: frenchDate(today),
    dueDate: null,
    centre: { name: centre.name, address: centre.address, taxId: centre.tax_id, footer: centre.invoice_footer },
    lines: original.lines.map((l) => ({ label: l.label, amount: -l.amount })),
    total: -invoice.total,
    net: -invoice.net,
    tax: -invoice.tax,
    credits: { number: invoice.number, issueDate: original.issueDate, reason: input.reason },
  };
  const pdf = await renderInvoice(snapshot);
  const row = await trx
    .insertInto("invoices")
    .values({
      centre_id: input.centreId,
      kind: "credit_note",
      number,
      year,
      sequence,
      student_id: invoice.student_id,
      renter_id: invoice.renter_id,
      member_id: invoice.member_id,
      credits_invoice_id: invoice.id,
      issue_date: today,
      due_date: null,
      snapshot: JSON.stringify(snapshot),
      total: -invoice.total,
      net: -invoice.net,
      tax: -invoice.tax,
      tax_bp: invoice.tax_bp,
      pdf,
      sha256: createHash("sha256").update(pdf).digest("hex"),
      created_by: input.userId,
    })
    .returning(["id", "number"])
    .executeTakeFirstOrThrow();
  await trx.updateTable("invoices").set({ status: "credited", credit_reason: input.reason }).where("id", "=", invoice.id).execute();
  await trx.updateTable("invoice_items").set({ active: false }).where("invoice_id", "=", invoice.id).execute();
  await writeAudit(trx, {
    centreId: input.centreId,
    userId: input.userId,
    action: "invoice.credited",
    objectType: "invoice",
    objectId: invoice.id,
    before: { status: "issued" },
    after: { status: "credited", creditNote: number },
    reason: input.reason,
  });
  return row;
}

/** What has been paid on each invoice, from the ledger allocations of the charges it lists, and its state. */
export async function invoiceStates(db: Db, centreId: string, ids: string[]): Promise<Map<string, { paid: number; remaining: number; state: InvoiceState }>> {
  const result = new Map<string, { paid: number; remaining: number; state: InvoiceState }>();
  if (ids.length === 0) return result;
  const { today } = await centreClock(db, centreId);
  const rows = await db
    .selectFrom("invoices as v")
    .leftJoin("invoice_items as it", "it.invoice_id", "v.id")
    .select([
      "v.id",
      "v.kind",
      "v.status",
      "v.total",
      "v.due_date as dueDate",
      sql<number>`coalesce(sum(least(it.amount, (select coalesce(sum(a.amount), 0) from effective_allocations a where a.installment_id = it.installment_id))), 0)::bigint`.as(
        "paid",
      ),
    ])
    .where("v.centre_id", "=", centreId)
    .where("v.id", "in", ids)
    .groupBy(["v.id", "v.kind", "v.status", "v.total", "v.due_date"])
    .execute();
  for (const r of rows) {
    const paid = Number(r.paid);
    if (r.kind === "credit_note") {
      result.set(r.id, { paid: 0, remaining: 0, state: "credit_note" });
      continue;
    }
    const remaining = r.status === "credited" ? 0 : Math.max(0, r.total - paid);
    const state: InvoiceState =
      r.status === "credited" ? "credited" : remaining === 0 ? "paid" : r.dueDate !== null && r.dueDate < today ? "overdue" : paid > 0 ? "partial" : "unpaid";
    result.set(r.id, { paid, remaining, state });
  }
  return result;
}

/**
 * E-mails the PDF of an invoice or credit note and records it as sent. A missing mailer or a delivery failure is
 * recorded in mail_dispatches and reported as failed; the document is then still marked unsent.
 */
export async function sendInvoice(
  db: Kysely<Database>,
  mailer: Mailer | null,
  log: FastifyBaseLogger,
  input: { centreId: string; invoiceId: string; to: string; userId: string },
): Promise<"sent" | "failed"> {
  const invoice = await db
    .selectFrom("invoices")
    .innerJoin("centres", "centres.id", "invoices.centre_id")
    .select([
      "invoices.id",
      "invoices.kind",
      "invoices.number",
      "invoices.pdf",
      "invoices.snapshot",
      "invoices.student_id",
      "invoices.renter_id",
      "invoices.member_id",
      "centres.name as centreName",
    ])
    .where("invoices.id", "=", input.invoiceId)
    .where("invoices.centre_id", "=", input.centreId)
    .executeTakeFirst();
  if (!invoice) throw notFound("invoice");
  const snapshot = invoice.snapshot as InvoiceSnapshot;
  const label = invoice.kind === "invoice" ? "Facture" : "Avoir";
  const text = [
    "Bonjour,",
    "",
    invoice.kind === "invoice"
      ? `Veuillez trouver ci-joint la facture ${invoice.number} d'un montant de ${formatTnd(snapshot.total)} TND, à régler avant le ${snapshot.dueDate}.`
      : `Veuillez trouver ci-joint l'avoir ${invoice.number}, qui annule la facture ${snapshot.credits?.number ?? ""}.`,
    "",
    "Cordialement,",
    invoice.centreName,
  ].join("\n");
  let status: "sent" | "failed" = "sent";
  let error: string | null = null;
  if (!mailer) {
    status = "failed";
    error = "outgoing e-mail is not configured";
  } else {
    try {
      await mailer.send({
        to: input.to,
        subject: `${label} ${invoice.number} - ${invoice.centreName}`,
        text,
        attachments: [{ filename: `${invoice.number}.pdf`, content: invoice.pdf, contentType: "application/pdf" }],
      });
    } catch (sendError) {
      status = "failed";
      error = sendError instanceof Error ? sendError.message.slice(0, 500) : "unknown error";
      log.warn({ err: sendError, invoiceId: invoice.id }, "invoice e-mail failed");
    }
  }
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("mail_dispatches")
      .values({
        centre_id: input.centreId,
        kind: "invoice",
        invoice_id: invoice.id,
        student_id: invoice.student_id,
        renter_id: invoice.renter_id,
        member_id: invoice.member_id,
        recipient: input.to,
        status,
        error,
        sent_by: input.userId,
        receipt_id: null,
      })
      .execute();
    if (status === "sent") {
      await trx.updateTable("invoices").set({ sent_at: new Date(), sent_to: input.to, sent_by: input.userId }).where("id", "=", invoice.id).execute();
      await writeAudit(trx, {
        centreId: input.centreId,
        userId: input.userId,
        action: "invoice.sent",
        objectType: "invoice",
        objectId: invoice.id,
        after: { to: input.to },
      });
    }
  });
  return status;
}

/** Records that an invoice was handed over by other means (printed, given at the desk). */
export async function markInvoiceDelivered(db: Kysely<Database>, input: { centreId: string; invoiceId: string; how: string; userId: string }): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable("invoices")
      .set({ sent_at: new Date(), sent_to: input.how, sent_by: input.userId })
      .where("id", "=", input.invoiceId)
      .where("centre_id", "=", input.centreId)
      .returning("id")
      .executeTakeFirst();
    if (!updated) throw notFound("invoice");
    await writeAudit(trx, {
      centreId: input.centreId,
      userId: input.userId,
      action: "invoice.delivered",
      objectType: "invoice",
      objectId: input.invoiceId,
      after: { how: input.how },
    });
  });
}
