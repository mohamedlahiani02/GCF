import type { Kysely, Transaction } from "kysely";
import type { Database } from "./db/types.js";
import { currentApiTokenId } from "./requestContext.js";

export interface AuditEntry {
  centreId: string;
  userId: string | null;
  action: string;
  objectType: string;
  objectId: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/**
 * Writes one audit row. Call it with the same transaction as the change it records. A change made through an
 * access token is attributed to that token as well as to the administrator it acts for.
 */
export async function writeAudit(db: Kysely<Database> | Transaction<Database>, entry: AuditEntry): Promise<void> {
  await db
    .insertInto("audit_log")
    .values({
      centre_id: entry.centreId,
      user_id: entry.userId,
      action: entry.action,
      object_type: entry.objectType,
      object_id: entry.objectId,
      before: entry.before === undefined ? null : JSON.stringify(entry.before),
      after: entry.after === undefined ? null : JSON.stringify(entry.after),
      reason: entry.reason ?? null,
      api_token_id: entry.userId === null ? null : currentApiTokenId(),
    })
    .execute();
}
