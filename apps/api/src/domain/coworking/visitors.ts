import { todayIn } from "@gcf/shared";
import { sql, type Kysely } from "kysely";
import { writeAudit } from "../../audit.js";
import type { Database } from "../../db/types.js";
import type { CwVisitorStatus } from "../../db/types.coworking.js";
import { conflict, notFound, unprocessable } from "../../errors.js";
import type { MailContext } from "./bookings.js";
import { sendMemberMail } from "./memberMail.js";
import { centreCalendar, coworkingSettings } from "./schedule.js";

export interface VisitorInput {
  hostMemberId: string;
  name: string;
  company?: string | null | undefined;
  phone?: string | null | undefined;
  expectedOn: string;
  expectedAt?: string | null | undefined;
  purpose?: string | null | undefined;
}

export type VisitorActor = { source: "staff"; userId: string } | { source: "portal"; memberId: string };

const VISITOR_COLUMNS = [
  "v.id",
  "v.host_member_id as hostMemberId",
  sql<string>`m.first_name || coalesce(' ' || m.last_name, '')`.as("hostName"),
  "c.name as hostCompany",
  "v.name",
  "v.company",
  "v.phone",
  "v.expected_on as expectedOn",
  sql<string | null>`to_char(v.expected_at, 'HH24:MI')`.as("expectedAt"),
  "v.purpose",
  "v.status",
  "v.announced_by as announcedBy",
  "v.arrived_at as arrivedAt",
  "v.left_at as leftAt",
] as const;

export function visitorRows(db: Kysely<Database>, centreId: string) {
  return db
    .selectFrom("cw_visitors as v")
    .innerJoin("members as m", "m.id", "v.host_member_id")
    .leftJoin("companies as c", "c.id", "m.company_id")
    .select(VISITOR_COLUMNS)
    .where("v.centre_id", "=", centreId);
}

export type VisitorRow = Awaited<ReturnType<ReturnType<typeof visitorRows>["execute"]>>[number];

const actorUser = (actor: VisitorActor) => (actor.source === "staff" ? actor.userId : null);

/** Announces a guest. The host must be an active client of the centre; a portal client announces only their own guests. */
export async function announceVisitor(db: Kysely<Database>, centreId: string, actor: VisitorActor, input: VisitorInput, now = new Date()): Promise<VisitorRow> {
  if (actor.source === "portal" && actor.memberId !== input.hostMemberId)
    throw unprocessable("visitor_host_mismatch", "a client announces only their own guests");
  const host = await db
    .selectFrom("members")
    .select(["id", "status"])
    .where("id", "=", input.hostMemberId)
    .where("centre_id", "=", centreId)
    .executeTakeFirst();
  if (!host) throw notFound("member");
  if (host.status !== "active") throw unprocessable("member_inactive", "the client account is not active");
  const { timezone } = await centreCalendar(db, centreId);
  if (input.expectedOn < todayIn(timezone, now)) throw unprocessable("visitor_date_past", "the visit date is past");
  const id = await db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto("cw_visitors")
      .values({
        centre_id: centreId,
        host_member_id: input.hostMemberId,
        name: input.name,
        company: input.company ?? null,
        phone: input.phone ?? null,
        expected_on: input.expectedOn,
        expected_at: input.expectedAt ?? null,
        purpose: input.purpose ?? null,
        announced_by: actor.source,
        created_by: actorUser(actor),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await writeAudit(trx, {
      centreId,
      userId: actorUser(actor),
      action: "cw_visitor.announced",
      objectType: "cw_visitor",
      objectId: row.id,
      after: { hostMemberId: input.hostMemberId, expectedOn: input.expectedOn, by: actor.source },
    });
    return row.id;
  });
  return visitorRows(db, centreId).where("v.id", "=", id).executeTakeFirstOrThrow();
}

const TRANSITIONS: Record<"arrive" | "leave" | "cancel", { from: CwVisitorStatus[]; to: CwVisitorStatus }> = {
  arrive: { from: ["expected"], to: "arrived" },
  leave: { from: ["arrived"], to: "left" },
  cancel: { from: ["expected"], to: "cancelled" },
};

/**
 * Moves a visit along: arrival and departure are recorded by the desk, a cancellation by the desk or by the host.
 * On arrival the host gets an e-mail when the centre has turned that on; a failed e-mail never blocks the arrival.
 */
export async function moveVisitor(
  db: Kysely<Database>,
  mail: MailContext,
  centreId: string,
  actor: VisitorActor,
  id: string,
  step: "arrive" | "leave" | "cancel",
  now = new Date(),
): Promise<VisitorRow> {
  const rule = TRANSITIONS[step];
  if (actor.source === "portal" && step !== "cancel") throw unprocessable("visitor_desk_only", "the front desk records arrivals and departures");
  await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom("cw_visitors")
      .select(["status", "host_member_id"])
      .where("id", "=", id)
      .where("centre_id", "=", centreId)
      .forUpdate()
      .executeTakeFirst();
    if (!before || (actor.source === "portal" && before.host_member_id !== actor.memberId)) throw notFound("visitor");
    if (!rule.from.includes(before.status)) throw conflict("visitor_wrong_status", `a visit that is ${before.status} cannot be moved this way`);
    await trx
      .updateTable("cw_visitors")
      .set({
        status: rule.to,
        ...(step === "arrive" ? { arrived_at: now } : step === "leave" ? { left_at: now } : { cancelled_at: now }),
      })
      .where("id", "=", id)
      .execute();
    await writeAudit(trx, {
      centreId,
      userId: actorUser(actor),
      action: `cw_visitor.${rule.to}`,
      objectType: "cw_visitor",
      objectId: id,
      before: { status: before.status },
      after: { status: rule.to, by: actor.source },
    });
  });
  const visitor = await visitorRows(db, centreId).where("v.id", "=", id).executeTakeFirstOrThrow();
  if (step === "arrive" && (await coworkingSettings(db, centreId)).visitor_notify_host) {
    const host = await db.selectFrom("members").select(["email", "first_name"]).where("id", "=", visitor.hostMemberId).executeTakeFirstOrThrow();
    const centre = await db.selectFrom("centres").select("name").where("id", "=", centreId).executeTakeFirstOrThrow();
    if (host.email) {
      await sendMemberMail(db, mail.mailer, mail.log, {
        centreId,
        memberId: visitor.hostMemberId,
        kind: "visitor",
        to: host.email,
        subject: `Votre visiteur ${visitor.name} est arrivé`,
        text: [
          `Bonjour ${host.first_name},`,
          "",
          `${visitor.name}${visitor.company ? ` (${visitor.company})` : ""} est arrivé à l'accueil.`,
          "",
          centre.name,
        ].join("\n"),
        sentBy: actorUser(actor),
      });
    }
  }
  return visitor;
}

/** Deletes visits older than each centre's retention period. Returns how many entries were removed. */
export async function purgeVisitors(db: Kysely<Database>, now = new Date()): Promise<number> {
  const removed = await sql<{ id: string }>`
    delete from cw_visitors v using cw_settings s, centres c
    where s.centre_id = v.centre_id and c.id = v.centre_id
      and v.expected_on < (${now}::timestamptz at time zone c.timezone)::date - s.visitor_retention_days
    returning v.id`.execute(db);
  return removed.rows.length;
}
