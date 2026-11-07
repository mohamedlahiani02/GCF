import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { writeAudit } from "../../audit.js";
import { can, type Actor } from "../../auth/permissions.js";
import type { Database, ProposalKind } from "../../db/types.js";
import { conflict, forbidden, HttpError, notFound } from "../../errors.js";
import type { Mailer } from "../../mail.js";
import { monthBounds } from "../payrollCalc.js";
import { calculateItems } from "../payItems.js";
import { sendReminders } from "../reminders.js";
import { PROPOSAL_PERMISSION } from "./definitions.js";

/** A proposal no one decided on expires after this many days. */
export const PROPOSAL_TTL_DAYS = 7;

const remindersPayload = z.object({ studentIds: z.array(z.string().uuid()).min(1) });
const payrollPayload = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), instructorIds: z.array(z.string().uuid()).min(1) });

export interface NewProposal {
  centreId: string;
  kind: ProposalKind;
  title: string;
  summary: unknown;
  payload: unknown;
  runId: string | null;
}

/** Records a proposal; a pending one of the same kind is superseded and marked expired. */
export async function createProposal(db: Kysely<Database>, input: NewProposal): Promise<string> {
  return db.transaction().execute(async (trx) => {
    await trx
      .updateTable("proposals")
      .set({ status: "expired" })
      .where("centre_id", "=", input.centreId)
      .where("kind", "=", input.kind)
      .where("status", "=", "pending")
      .execute();
    const row = await trx
      .insertInto("proposals")
      .values({
        centre_id: input.centreId,
        kind: input.kind,
        title: input.title,
        summary: JSON.stringify(input.summary),
        payload: JSON.stringify(input.payload),
        run_id: input.runId,
        expires_at: sql<Date>`now() + make_interval(days => ${PROPOSAL_TTL_DAYS})`,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await writeAudit(trx, {
      centreId: input.centreId,
      userId: null,
      action: "proposal.created",
      objectType: "proposal",
      objectId: row.id,
      after: { kind: input.kind, title: input.title },
    });
    return row.id;
  });
}

/** Marks as expired the pending proposals whose time is up. */
export async function expireProposals(db: Kysely<Database>, centreId: string): Promise<void> {
  await db
    .updateTable("proposals")
    .set({ status: "expired" })
    .where("centre_id", "=", centreId)
    .where("status", "=", "pending")
    .where("expires_at", "<=", sql<Date>`now()`)
    .execute();
}

export type DecisionActor = Actor & { centreId: string; userId: string };

/**
 * Confirms or rejects a pending proposal. The decision is claimed first in its own transaction, so a proposal is
 * never carried out twice; it is then carried out with the confirming person's rights and name, from the data as it
 * stands at that moment (a student who has paid since the proposal gets no reminder). A failure is recorded on the
 * proposal and returned as an error.
 */
export async function decideProposal(
  db: Kysely<Database>,
  mailer: Mailer | null,
  actor: DecisionActor,
  id: string,
  decision: { approve: boolean; note: string | null },
): Promise<{ id: string; status: "confirmed" | "rejected"; result: unknown }> {
  const proposal = await db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("proposals")
      .select(["id", "kind", "status", "payload", sql<boolean>`expires_at <= now()`.as("expired")])
      .where("id", "=", id)
      .where("centre_id", "=", actor.centreId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw notFound("proposal");
    if (!can(actor, PROPOSAL_PERMISSION[row.kind])) throw forbidden();
    if (row.status !== "pending" || row.expired) throw conflict("proposal_closed", "this proposal has already been decided or has expired");
    if (decision.approve && row.kind === "reminders.send" && !mailer) {
      throw new HttpError(503, "mail_not_configured", "outgoing e-mail is not configured on this server");
    }
    await trx
      .updateTable("proposals")
      .set({ status: decision.approve ? "confirmed" : "rejected", decided_by: actor.userId, decided_at: new Date(), decision_note: decision.note })
      .where("id", "=", id)
      .execute();
    await writeAudit(trx, {
      centreId: actor.centreId,
      userId: actor.userId,
      action: decision.approve ? "proposal.confirmed" : "proposal.rejected",
      objectType: "proposal",
      objectId: id,
      reason: decision.note,
    });
    return row;
  });
  if (!decision.approve) return { id, status: "rejected", result: null };

  try {
    const result = await carryOut(db, mailer, actor, proposal.kind, proposal.payload);
    await db
      .updateTable("proposals")
      .set({ result: JSON.stringify(result) })
      .where("id", "=", id)
      .execute();
    return { id, status: "confirmed", result };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "unknown error";
    await db.updateTable("proposals").set({ status: "failed", error: message }).where("id", "=", id).execute();
    throw error;
  }
}

async function carryOut(db: Kysely<Database>, mailer: Mailer | null, actor: DecisionActor, kind: ProposalKind, payload: unknown): Promise<unknown> {
  if (kind === "reminders.send") {
    const { studentIds } = remindersPayload.parse(payload);
    const results = await sendReminders(db, mailer!, actor.centreId, studentIds, actor.userId, "relances proposées par l'automatisation hebdomadaire");
    return { results };
  }
  const { month, instructorIds } = payrollPayload.parse(payload);
  const { start, end } = monthBounds(month);
  const totals = { created: 0, unchanged: 0, replaced: 0, warnings: 0 };
  for (const instructorId of instructorIds) {
    const result = await db.transaction().execute((trx) => calculateItems(trx, actor, instructorId, { from: start, to: end }));
    totals.created += result.created;
    totals.unchanged += result.unchanged;
    totals.replaced += result.replaced;
    totals.warnings += result.warnings.length;
  }
  return { month, ...totals };
}
