import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { creditInvoice, invoiceStates, issueInvoice, markInvoiceDelivered, sendInvoice, uninvoicedCharges, type InvoiceState } from "../domain/invoices.js";
import type { InvoiceSnapshot } from "../domain/invoicePdf.js";
import type { Payer } from "../domain/ledger.js";
import { notFound, unprocessable } from "../errors.js";
import { idParam, reason, requiredText, uuid } from "../validation.js";

const payerSchema = z.object({ kind: z.enum(["student", "renter", "member"]), id: uuid });
const payerQuery = z.object({ payerKind: z.enum(["student", "renter", "member"]), payerId: uuid });
const listQuery = z.object({
  state: z.enum(["all", "unpaid", "overdue", "paid", "credited", "unsent", "credit_note"]).default("all"),
  payerKind: z.enum(["student", "renter", "member"]).optional(),
  payerId: uuid.optional(),
  q: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const issueBody = z.object({ payer: payerSchema, installmentIds: z.array(uuid).min(1).max(200) }).strict();
const sendBody = z.object({ to: z.string().trim().toLowerCase().email().max(200) }).strict();
const deliveredBody = z.object({ how: requiredText(120) }).strict();
const creditBody = z.object({ reason }).strict();

const PAYER_COLUMN = { student: "v.student_id", renter: "v.renter_id", member: "v.member_id" } as const;
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Invoices and credit notes: what can be invoiced, issuing, sending, crediting, and the archived PDFs. */
export const invoiceRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const read = app.requirePermission("invoices:read");
  const write = app.requirePermission("invoices:write");
  const cancel = app.requirePermission("invoices:cancel");

  /** Open charges of a payer that no standing invoice lists yet. */
  app.get("/uninvoiced", { preHandler: read }, async (request) => {
    const { payerKind, payerId } = payerQuery.parse(request.query);
    const charges = await uninvoicedCharges(db, request.user!.centreId, { kind: payerKind, id: payerId } as Payer);
    return charges.map((c) => ({ id: c.id, label: c.label, amount: c.amount, dueDate: c.dueDate, paid: c.paid, remaining: c.remaining, state: c.state }));
  });

  app.get("/", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const query = listQuery.parse(request.query);
    if ((query.payerKind === undefined) !== (query.payerId === undefined)) throw unprocessable("payer_incomplete", "give both payerKind and payerId");
    const rows = await db
      .selectFrom("invoices as v")
      .select([
        "v.id",
        "v.kind",
        "v.number",
        "v.issue_date as issueDate",
        "v.due_date as dueDate",
        "v.total",
        "v.status",
        "v.sent_at as sentAt",
        "v.sent_to as sentTo",
        "v.student_id as studentId",
        "v.renter_id as renterId",
        "v.member_id as memberId",
        sql<string>`v.snapshot -> 'buyer' ->> 'name'`.as("buyerName"),
      ])
      .where("v.centre_id", "=", centreId)
      .$if(query.payerKind !== undefined, (qb) => qb.where(PAYER_COLUMN[query.payerKind!], "=", query.payerId!))
      .$if(query.state === "credit_note", (qb) => qb.where("v.kind", "=", "credit_note"))
      .$if(query.state === "credited", (qb) => qb.where("v.status", "=", "credited"))
      .$if(query.state === "unsent", (qb) => qb.where("v.sent_at", "is", null).where("v.status", "=", "issued"))
      .$if(["unpaid", "overdue", "paid"].includes(query.state), (qb) => qb.where("v.kind", "=", "invoice").where("v.status", "=", "issued"))
      .$if(!!query.q, (qb) =>
        qb.where((eb) =>
          eb.or([
            eb("v.number", "ilike", `%${escapeLike(query.q!)}%`),
            eb(sql<string>`v.snapshot -> 'buyer' ->> 'name'`, "ilike", `%${escapeLike(query.q!)}%`),
          ]),
        ),
      )
      .orderBy("v.issue_date", "desc")
      .orderBy("v.created_at", "desc")
      .execute();
    const states = await invoiceStates(
      db,
      centreId,
      rows.map((r) => r.id),
    );
    const wanted: Partial<Record<typeof query.state, InvoiceState[]>> = { unpaid: ["unpaid", "partial", "overdue"], overdue: ["overdue"], paid: ["paid"] };
    const filtered = rows.map((r) => ({ ...r, ...states.get(r.id)! })).filter((r) => !wanted[query.state] || wanted[query.state]!.includes(r.state));
    const start = (query.page - 1) * query.pageSize;
    const totals = filtered.reduce(
      (t, r) => (r.kind === "invoice" && r.status === "issued" ? { invoiced: t.invoiced + r.total, remaining: t.remaining + r.remaining } : t),
      {
        invoiced: 0,
        remaining: 0,
      },
    );
    return { items: filtered.slice(start, start + query.pageSize), hasMore: filtered.length > start + query.pageSize, page: query.page, totals };
  });

  app.get("/:id", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const { id } = idParam.parse(request.params);
    const invoice = await db
      .selectFrom("invoices as v")
      .leftJoin("users as u", "u.id", "v.sent_by")
      .select([
        "v.id",
        "v.kind",
        "v.number",
        "v.issue_date as issueDate",
        "v.due_date as dueDate",
        "v.total",
        "v.net",
        "v.tax",
        "v.tax_bp as taxBp",
        "v.status",
        "v.credit_reason as creditReason",
        "v.credits_invoice_id as creditsInvoiceId",
        "v.sent_at as sentAt",
        "v.sent_to as sentTo",
        "u.full_name as sentBy",
        "v.student_id as studentId",
        "v.renter_id as renterId",
        "v.member_id as memberId",
        "v.snapshot",
        "v.sha256",
      ])
      .where("v.id", "=", id)
      .where("v.centre_id", "=", centreId)
      .executeTakeFirst();
    if (!invoice) throw notFound("invoice");
    const creditNote = await db.selectFrom("invoices").select(["id", "number"]).where("credits_invoice_id", "=", id).executeTakeFirst();
    const dispatches = await db
      .selectFrom("mail_dispatches")
      .select(["sent_at as sentAt", "recipient", "status", "error"])
      .where("invoice_id", "=", id)
      .orderBy("sent_at")
      .execute();
    const { snapshot, ...rest } = invoice;
    return {
      ...rest,
      ...(await invoiceStates(db, centreId, [id])).get(id)!,
      snapshot: snapshot as InvoiceSnapshot,
      creditNote: creditNote ?? null,
      dispatches,
    };
  });

  app.get("/:id/pdf", { preHandler: read }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const invoice = await db
      .selectFrom("invoices")
      .select(["number", "pdf"])
      .where("id", "=", id)
      .where("centre_id", "=", request.user!.centreId)
      .executeTakeFirst();
    if (!invoice) throw notFound("invoice");
    return reply.header("content-type", "application/pdf").header("content-disposition", `inline; filename="${invoice.number}.pdf"`).send(invoice.pdf);
  });

  app.post("/", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const body = issueBody.parse(request.body);
    const created = await db
      .transaction()
      .execute((trx) => issueInvoice(trx, { centreId: actor.centreId, payer: body.payer as Payer, installmentIds: body.installmentIds, userId: actor.userId }));
    return reply.status(201).send(created);
  });

  app.post("/:id/send", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { to } = sendBody.parse(request.body);
    return { status: await sendInvoice(db, app.mailer, request.log, { centreId: actor.centreId, invoiceId: id, to, userId: actor.userId }) };
  });

  app.post("/:id/delivered", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { how } = deliveredBody.parse(request.body);
    await markInvoiceDelivered(db, { centreId: actor.centreId, invoiceId: id, how, userId: actor.userId });
    return reply.status(204).send();
  });

  app.post("/:id/credit", { preHandler: cancel }, async (request, reply) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = creditBody.parse(request.body);
    const created = await db
      .transaction()
      .execute((trx) => creditInvoice(trx, { centreId: actor.centreId, invoiceId: id, reason: body.reason, userId: actor.userId }));
    return reply.status(201).send(created);
  });
};
