import { createHash, randomBytes } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/types.js";

type Db = Kysely<Database> | Transaction<Database>;

export type MemberTokenPurpose = "activation" | "password_reset";

/** How long a link stays valid: an invitation may wait a few days, a password reset must be used quickly. */
export const MEMBER_TOKEN_TTL_MINUTES: Record<MemberTokenPurpose, number> = { activation: 72 * 60, password_reset: 60 };

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/**
 * Issues a single-use link token for a member and returns it with its expiry. Only its SHA-256 hash is stored.
 * Unused tokens of the same purpose are deleted, so only the latest link sent works.
 */
export async function issueMemberToken(
  db: Db,
  memberId: string,
  purpose: MemberTokenPurpose,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + MEMBER_TOKEN_TTL_MINUTES[purpose] * 60_000);
  await db.deleteFrom("member_tokens").where("member_id", "=", memberId).where("purpose", "=", purpose).where("used_at", "is", null).execute();
  await db
    .insertInto("member_tokens")
    .values({ member_id: memberId, purpose, token_hash: hashToken(token), expires_at: expiresAt })
    .execute();
  return { token, expiresAt };
}

/**
 * Marks a valid token as used and returns its member. A token works once, before its expiry and only for its
 * purpose; the conditional update makes two concurrent uses impossible. Returns undefined for any invalid token.
 */
export async function consumeMemberToken(
  db: Db,
  token: string,
  purpose: MemberTokenPurpose,
  now: Date = new Date(),
): Promise<{ memberId: string } | undefined> {
  const row = await db
    .updateTable("member_tokens")
    .set({ used_at: now })
    .where("token_hash", "=", hashToken(token))
    .where("purpose", "=", purpose)
    .where("used_at", "is", null)
    .where("expires_at", ">", now)
    .returning("member_id")
    .executeTakeFirst();
  return row ? { memberId: row.member_id } : undefined;
}
