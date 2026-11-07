import type { FastifyBaseLogger } from "fastify";
import { sql, type Kysely, type Transaction } from "kysely";
import { writeAudit } from "../../audit.js";
import type { CwMailKind } from "../../db/types.coworking.js";
import type { Database } from "../../db/types.js";
import { conflict, notFound, unprocessable } from "../../errors.js";
import type { Mailer } from "../../mail.js";
import { centreClock } from "../ledger.js";
import { sendMemberMail } from "./memberMail.js";

const MAIL_KIND_FR: Record<CwMailKind, string> = { letter: "une lettre", registered: "une lettre recommandée", parcel: "un colis", other: "un envoi" };

/** Locks a mail item that is still at the reception (received or notified, not yet collected or returned). */
export async function lockOpenMailItem(trx: Transaction<Database>, centreId: string, id: string) {
  const item = await trx
    .selectFrom("cw_mail_items")
    .select(["id", "member_id", "status", "kind", "sender", "received_at"])
    .where("id", "=", id)
    .where("centre_id", "=", centreId)
    .forUpdate()
    .executeTakeFirst();
  if (!item) throw notFound("mail item");
  if (item.status !== "received" && item.status !== "notified") throw conflict("mail_item_closed", "this mail has already been collected or returned");
  return item;
}

/**
 * Marks a mail item as notified and e-mails its member. `sentBy` is the staff member who asked, or null when the
 * centre's automatic notice did it; the reason then says so in the audit log. Refused (no_recipient) when the
 * member has no e-mail address.
 */
export async function notifyMailItem(
  db: Kysely<Database>,
  mailer: Mailer | null,
  log: FastifyBaseLogger,
  centreId: string,
  id: string,
  sentBy: string | null,
): Promise<"sent" | "failed"> {
  const notice = await db.transaction().execute(async (trx) => {
    const item = await lockOpenMailItem(trx, centreId, id);
    const member = await trx.selectFrom("members").select(["email", "first_name"]).where("id", "=", item.member_id).executeTakeFirstOrThrow();
    if (!member.email) throw unprocessable("no_recipient", "the member has no e-mail address");
    const { timezone } = await centreClock(trx, centreId);
    const received = await sql<{ day: string }>`select to_char(${item.received_at}::timestamptz at time zone ${timezone}, 'DD/MM/YYYY') as day`.execute(trx);
    await trx.updateTable("cw_mail_items").set({ status: "notified", notified_at: new Date() }).where("id", "=", id).execute();
    await writeAudit(trx, {
      centreId,
      userId: sentBy,
      action: "cw_mail_item.notified",
      objectType: "cw_mail_item",
      objectId: id,
      before: { status: item.status },
      after: { status: "notified" },
      reason: sentBy === null ? "avis automatique à la réception" : null,
    });
    return { item, member: { email: member.email, firstName: member.first_name }, day: received.rows[0]!.day };
  });
  const centre = await db.selectFrom("centres").select("name").where("id", "=", centreId).executeTakeFirstOrThrow();
  const from = notice.item.sender ? ` de la part de ${notice.item.sender}` : "";
  return sendMemberMail(db, mailer, log, {
    centreId,
    memberId: notice.item.member_id,
    kind: "mail_item",
    to: notice.member.email,
    subject: `${centre.name} : du courrier vous attend`,
    text: `Bonjour ${notice.member.firstName},\n\nNous avons reçu ${MAIL_KIND_FR[notice.item.kind]}${from} pour vous le ${notice.day}. Vous pouvez le retirer à l'accueil aux heures d'ouverture.\n\n${centre.name}`,
    sentBy,
  });
}
