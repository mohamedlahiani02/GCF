import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { renderReceipt, type ReceiptSnapshot } from "../domain/receiptPdf.js";
import { financialActivity, paymentActivities } from "../domain/paymentActivity.js";
import { HttpError, notFound } from "../errors.js";
import { idParam, isoDate, optionalEmail } from "../validation.js";

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  activity: financialActivity.optional(),
  kind: z.enum(["payment", "refund", "cancellation"]).optional(),
  status: z.enum(["valid", "cancelled", "cancellation"]).optional(),
  dispatch: z.enum(["sent", "failed", "not_sent"]).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const pdfQuery = z.object({ format: z.enum(["A4", "A5"]).default("A4") });
const sendBody = z.object({ to: optionalEmail }).strict();

const currentPayerName = sql<string>`coalesce(
  nullif(concat_ws(' ', students.first_name, students.last_name), ''),
  renters.name,
  concat_ws(' ', members.first_name, members.last_name)
)`;
const payerName = sql<string>`coalesce(nullif(receipts.snapshot->'payer'->>'name', ''), ${currentPayerName})`;
const lastDispatch = sql<string | null>`(
  select mail_dispatches.status from mail_dispatches
  where mail_dispatches.receipt_id = receipts.id
  order by mail_dispatches.sent_at desc, mail_dispatches.id desc
  limit 1
)`;
const receiptStatus = sql<string>`case
  when receipts.kind = 'cancellation' then 'cancellation'
  when payments.status = 'cancelled' then 'cancelled'
  else 'valid'
end`;

export const receiptRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const read = app.requirePermission("payments:read");

  app.get("/", { preHandler: read }, async (request) => {
    const query = listQuery.parse(request.query);
    const centreId = request.user!.centreId;
    const centre = await db.selectFrom("centres").select("timezone").where("id", "=", centreId).executeTakeFirstOrThrow();
    const rows = await db
      .selectFrom("receipts")
      .innerJoin("payments", "payments.id", "receipts.payment_id")
      .leftJoin("students", "students.id", "payments.student_id")
      .leftJoin("renters", "renters.id", "payments.renter_id")
      .leftJoin("members", "members.id", "payments.member_id")
      .select([
        "receipts.id",
        "receipts.number",
        "receipts.kind",
        "receipts.issued_at as issuedAt",
        payerName.as("payerName"),
        paymentActivities.as("activities"),
        "students.first_name as firstName",
        "students.last_name as lastName",
        "renters.name as renterName",
        sql<string | null>`case when members.id is null then null else concat_ws(' ', members.first_name, members.last_name) end`.as("memberName"),
        "payments.amount",
        "payments.status as paymentStatus",
        lastDispatch.as("lastDispatch"),
      ])
      .where("receipts.centre_id", "=", centreId)
      .$if(!!query.q, (qb) => {
        const pattern = `%${query.q!.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        return qb.where((eb) => eb.or([eb("receipts.number", "ilike", pattern), eb(payerName, "ilike", pattern), eb(currentPayerName, "ilike", pattern)]));
      })
      .$if(query.activity !== undefined, (qb) => qb.where(sql<boolean>`${query.activity!} = any(${paymentActivities})`))
      .$if(query.kind !== undefined, (qb) => qb.where("receipts.kind", "=", query.kind!))
      .$if(query.status !== undefined, (qb) => qb.where(receiptStatus, "=", query.status!))
      .$if(query.dispatch !== undefined, (qb) => qb.where(sql<string>`coalesce(${lastDispatch}, 'not_sent')`, "=", query.dispatch!))
      .$if(query.from !== undefined, (qb) => qb.where(sql<string>`(receipts.issued_at at time zone ${centre.timezone})::date`, ">=", query.from!))
      .$if(query.to !== undefined, (qb) => qb.where(sql<string>`(receipts.issued_at at time zone ${centre.timezone})::date`, "<=", query.to!))
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
    const prints = await db
      .selectFrom("receipt_prints")
      .leftJoin("users", "users.id", "receipt_prints.printed_by")
      .select(["receipt_prints.printed_at as printedAt", "receipt_prints.duplicate", "users.full_name as printedBy"])
      .where("receipt_id", "=", id)
      .orderBy("printed_at")
      .execute();
    const dispatches = await db
      .selectFrom("mail_dispatches")
      .select(["sent_at as sentAt", "recipient", "status", "error"])
      .where("receipt_id", "=", id)
      .orderBy("sent_at")
      .execute();
    const cancellation = await db.selectFrom("receipts").select(["id", "number"]).where("cancels_receipt_id", "=", id).executeTakeFirst();
    return { ...receipt, immutable: true, cancelledBy: cancellation ?? null, prints, dispatches };
  });

  /** On-screen view of the archived original. Viewing is not printing: it is neither logged nor a duplicate. */
  app.get("/:id/view", { preHandler: read }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const receipt = await db
      .selectFrom("receipts")
      .select(["number", "pdf"])
      .where("id", "=", id)
      .where("centre_id", "=", request.user!.centreId)
      .executeTakeFirst();
    if (!receipt) throw notFound("receipt");
    return reply.header("content-type", "application/pdf").header("content-disposition", `inline; filename="${receipt.number}.pdf"`).send(receipt.pdf);
  });

  /** The first print is the original; every later print carries the DUPLICATA mention. */
  app.get("/:id/pdf", { preHandler: read }, async (request, reply) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { format } = pdfQuery.parse(request.query);
    const receipt = await db
      .selectFrom("receipts")
      .select(["id", "number", "snapshot", "pdf"])
      .where("id", "=", id)
      .where("centre_id", "=", actor.centreId)
      .executeTakeFirst();
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
      .leftJoin("members", "members.id", "payments.member_id")
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
        "payments.member_id as memberId",
        "members.email as memberEmail",
        "centres.name as centreName",
      ])
      .where("receipts.id", "=", id)
      .where("receipts.centre_id", "=", actor.centreId)
      .executeTakeFirst();
    if (!receipt) throw notFound("receipt");
    const to =
      body.to ??
      (receipt.memberId
        ? receipt.memberEmail
        : receipt.renterId
          ? receipt.renterEmail
          : (receipt.receiptEmail ?? (receipt.isMinor ? receipt.guardianEmail : receipt.email) ?? receipt.email));
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
    await db
      .insertInto("mail_dispatches")
      .values({
        centre_id: actor.centreId,
        kind: "receipt",
        receipt_id: id,
        student_id: receipt.studentId,
        renter_id: receipt.renterId,
        member_id: receipt.memberId,
        recipient: to,
        status,
        error,
        sent_by: actor.userId,
      })
      .execute();
    await writeAudit(db, {
      centreId: actor.centreId,
      userId: actor.userId,
      action: `receipt.mail_${status}`,
      objectType: "receipt",
      objectId: id,
      after: { to },
    });
    return { id, recipient: to, status, error };
  });
};
