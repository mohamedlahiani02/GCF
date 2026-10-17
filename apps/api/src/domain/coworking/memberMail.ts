import type { FastifyBaseLogger } from "fastify";
import type { Kysely, Transaction } from "kysely";
import type { Database, MailDispatchKind } from "../../db/types.js";
import type { Mailer } from "../../mail.js";

export interface MemberMail {
  centreId: string;
  memberId: string;
  kind: Exclude<MailDispatchKind, "receipt" | "reminder">;
  to: string;
  subject: string;
  text: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
  sentBy: string | null;
}

/**
 * Sends one e-mail to a coworking member and records the attempt in mail_dispatches. A missing mailer or a
 * delivery failure never fails the business operation that triggered the message: it is recorded as failed.
 * Call it after the transaction of that operation has committed.
 */
export async function sendMemberMail(
  db: Kysely<Database> | Transaction<Database>,
  mailer: Mailer | null,
  log: FastifyBaseLogger,
  mail: MemberMail,
): Promise<"sent" | "failed"> {
  let status: "sent" | "failed" = "sent";
  let error: string | null = null;
  if (!mailer) {
    status = "failed";
    error = "outgoing e-mail is not configured";
  } else {
    try {
      await mailer.send({ to: mail.to, subject: mail.subject, text: mail.text, ...(mail.attachments ? { attachments: mail.attachments } : {}) });
    } catch (sendError) {
      status = "failed";
      error = sendError instanceof Error ? sendError.message.slice(0, 500) : "unknown error";
      log.warn({ err: sendError, kind: mail.kind, memberId: mail.memberId }, "member e-mail failed");
    }
  }
  await db
    .insertInto("mail_dispatches")
    .values({ centre_id: mail.centreId, kind: mail.kind, member_id: mail.memberId, recipient: mail.to, status, error, sent_by: mail.sentBy })
    .execute();
  return status;
}

/** Absolute link into the client portal, or null when no public origin is configured. */
export function portalLink(publicOrigin: string | null, path: string): string | null {
  return publicOrigin ? `${publicOrigin}/espace${path.startsWith("/") ? path : `/${path}`}` : null;
}
