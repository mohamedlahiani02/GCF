import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { renderReceipt, type ReceiptSnapshot } from "../domain/receiptPdf.js";
import { HttpError, notFound } from "../errors.js";
import { idParam, optionalEmail } from "../validation.js";

const listQuery = z.object({
  q: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const pdfQuery = z.object({ format: z.enum(["A4", "A5"]).default("A4") });
const sendBody = z.object({ to: optionalEmail }).strict();

export const receiptRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const read = app.requirePermission("payments:read");

  app.get("/", { preHandler: read }, async (request) => {
    const query = listQuery.parse(request.query);
    const rows = await db
      .selectFrom("receipts")
      .innerJoin("payments", "payments.id", "receipts.payment_id")
      .leftJoin("students", "students.id", "payments.student_id")
      .leftJoin("renters", "renters.id", "payments.renter_id")
      .select((eb) => [
        "receipts.id",
        "receipts.number",
        "receipts.kind",
        "receipts.issued_at as issuedAt",
        "students.first_name as firstName",
        "students.last_name as lastName",
        "renters.name as renterName",
        "payments.amount",
        "payments.status as paymentStatus",
        eb
          .selectFrom("mail_dispatches")
          .select("mail_dispatches.status")
          .whereRef("mail_dispatches.receipt_id", "=", "receipts.id")
          .orderBy("mail_dispatches.sent_at", "desc")
          .limit(1)
          .as("lastDispatch"),
      ])
      .where("receipts.centre_id", "=", request.user!.centreId)
      .$if(!!query.q, (qb) => qb.where("receipts.number", "ilike", `%${query.q!.replace(/[\\%_]/g, (c) => `\\${c}`)}%`))
      .orderBy("receipts.year", "desc")
      .orderBy("receipts.sequence", "desc")
      .limit(query.pageSize + 1)
      .offset((query.page - 1) * query.pageSize)
      .execute();
    return {
      items: rows.slice(0, query.pageSize).map((r) => ({
        ...r,
        status: r.kind === "cancellation" ? "cancellation" : r.paymentStatus === "cancelled" ? "cancelled" : "valid",
        dispatch: r.lastDispatch ?? "not_sent",
      })),
      hasMore: rows.length > query.pageSize,
      page: query.page,
    };
  });

  app.get("/:id", { preHandler: read }, async (request) => {
    const { id } = idParam.parse(request.params);
    const receipt = await db
      .selectFrom("receipts")
      .select(["id", "number", "kind", "issued_at as issuedAt", "payment_id as paymentId", "cancels_receipt_id as cancelsReceiptId", "sha256", "snapshot"])
      .where("id", "=", id)
      .where("centre_id", "=", request.user!.centreId)
      .executeTakeFirst();
    if (!receipt) throw notFound("receipt");
    const prints = await db.selectFrom("receipt_prints").leftJoin("users", "users.id", "receipt_prints.printed_by").select(["receipt_prints.printed_at as printedAt", "receipt_prints.duplicate", "users.full_name as printedBy"]).where("receipt_id", "=", id).orderBy("printed_at").execute();
    const dispatches = await db.selectFrom("mail_dispatches").select(["sent_at as sentAt", "recipient", "status", "error"]).where("receipt_id", "=", id).orderBy("sent_at").execute();
    const cancellation = await db.selectFrom("receipts").select(["id", "number"]).where("cancels_receipt_id", "=", id).executeTakeFirst();
    return { ...receipt, immutable: true, cancelledBy: cancellation ?? null, prints, dispatches };
  });

  /** The first print is the original; every later print carries the DUPLICATA mention. */
  app.get("/:id/pdf", { preHandler: read }, async (request, reply) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { format } = pdfQuery.parse(request.query);
    const receipt = await db.selectFrom("receipts").select(["id", "number", "snapshot", "pdf"]).where("id", "=", id).where("centre_id", "=", actor.centreId).executeTakeFirst();
    if (!receipt) throw notFound("receipt");
    const printed = await db.selectFrom("receipt_prints").select("id").where("receipt_id", "=", id).executeTakeFirst();
    const duplicate = !!printed;
    const pdf = !duplicate && format === "A4" ? receipt.pdf : await renderReceipt(receipt.snapshot as ReceiptSnapshot, { format, duplicate });
    await db.insertInto("receipt_prints").values({ receipt_id: id, printed_by: actor.userId, duplicate }).execute();
    return reply
      .header("content-type", "application/pdf")
      .header("content-disposition", `inline; filename="${receipt.number}${duplicate ? "-duplicata" : ""}.pdf"`)
      .send(pdf);
  });

  app.post("/:id/send", { preHandler: app.requirePermission("payments:write") }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = sendBody.parse(request.body ?? {});
    if (!app.mailer) throw new HttpError(503, "mail_not_configured", "outgoing e-mail is not configured on this server");
    const receipt = await db
      .selectFrom("receipts")
      .innerJoin("payments", "payments.id", "receipts.payment_id")
      .leftJoin("students", "students.id", "payments.student_id")
      .leftJoin("renters", "renters.id", "payments.renter_id")
      .innerJoin("centres", "centres.id", "receipts.centre_id")
      .select([
        "receipts.id",
        "receipts.number",
        "receipts.pdf",
        "payments.student_id as studentId",
        "payments.renter_id as renterId",
        "students.receipt_email as receiptEmail",
        "students.email",
        "students.guardian_email as guardianEmail",
        "students.is_minor as isMinor",
        "renters.email as renterEmail",
        "centres.name as centreName",
      ])
      .where("receipts.id", "=", id)
      .where("receipts.centre_id", "=", actor.centreId)
      .executeTakeFirst();
    if (!receipt) throw notFound("receipt");
    const to = body.to ?? (receipt.renterId ? receipt.renterEmail : (receipt.receiptEmail ?? (receipt.isMinor ? receipt.guardianEmail : receipt.email) ?? receipt.email));
    if (!to) throw new HttpError(422, "no_recipient", "no e-mail address is known for this payer");
    let status: "sent" | "failed" = "sent";
    let error: string | null = null;
    try {
      await app.mailer.send({
        to,
        subject: `${receipt.centreName} : reçu ${receipt.number}`,
        text: `Bonjour,\n\nVeuillez trouver ci-joint le reçu ${receipt.number}.\n\n${receipt.centreName}\nCe message est envoyé automatiquement, merci de ne pas y répondre.`,
        attachments: [{ filename: `${receipt.number}.pdf`, content: receipt.pdf, contentType: "application/pdf" }],
      });
    } catch (sendError) {
      status = "failed";
      error = sendError instanceof Error ? sendError.message.slice(0, 500) : "unknown error";
      request.log.warn({ err: sendError, receipt: receipt.number }, "receipt e-mail failed");
    }
    await db.insertInto("mail_dispatches").values({ centre_id: actor.centreId, kind: "receipt", receipt_id: id, student_id: receipt.studentId, renter_id: receipt.renterId, recipient: to, status, error, sent_by: actor.userId }).execute();
    await writeAudit(db, { centreId: actor.centreId, userId: actor.userId, action: `receipt.mail_${status}`, objectType: "receipt", objectId: id, after: { to } });
    return { id, recipient: to, status, error };
  });
};
