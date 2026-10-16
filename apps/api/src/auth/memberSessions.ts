import { createHash, randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database, MemberKind, MemberStatus } from "../db/types.js";
import type { SessionPolicy } from "./sessions.js";

/** A coworking client signed in to the portal. Kept apart from staff sessions: other table, other cookie. */
export interface MemberSession {
  sessionId: string;
  memberId: string;
  centreId: string;
  kind: MemberKind;
  status: MemberStatus;
  email: string;
  firstName: string;
  lastName: string | null;
  companyId: string | null;
  companyRole: "admin" | "member" | null;
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** Creates a member session and returns the opaque cookie token. Only its SHA-256 hash is stored. */
export async function createMemberSession(db: Kysely<Database>, memberId: string, policy: SessionPolicy, userAgent: string | undefined): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db
    .insertInto("member_sessions")
    .values({
      member_id: memberId,
      token_hash: hashToken(token),
      absolute_expires_at: new Date(Date.now() + policy.absoluteHours * 3_600_000),
      user_agent: userAgent ?? null,
    })
    .execute();
  return token;
}

/**
 * Resolves a token to a member and slides the idle window. Expired sessions and sessions of disabled members
 * are deleted, so disabling a member signs them out at their next request.
 */
export async function resolveMemberSession(db: Kysely<Database>, token: string, policy: SessionPolicy): Promise<MemberSession | undefined> {
  const row = await db
    .selectFrom("member_sessions")
    .innerJoin("members", "members.id", "member_sessions.member_id")
    .select([
      "member_sessions.id as sessionId",
      "member_sessions.last_seen_at as lastSeenAt",
      "member_sessions.absolute_expires_at as absoluteExpiresAt",
      "members.id as memberId",
      "members.centre_id as centreId",
      "members.kind",
      "members.status",
      "members.email",
      "members.first_name as firstName",
      "members.last_name as lastName",
      "members.company_id as companyId",
      "members.company_role as companyRole",
    ])
    .where("member_sessions.token_hash", "=", hashToken(token))
    .executeTakeFirst();
  if (!row) return undefined;
  const now = Date.now();
  const idleExpired = now - new Date(row.lastSeenAt).getTime() > policy.idleMinutes * 60_000;
  const absoluteExpired = now >= new Date(row.absoluteExpiresAt).getTime();
  if (idleExpired || absoluteExpired || row.status === "disabled" || row.kind !== "member" || row.email === null) {
    await db.deleteFrom("member_sessions").where("id", "=", row.sessionId).execute();
    return undefined;
  }
  await db
    .updateTable("member_sessions")
    .set({ last_seen_at: new Date(now) })
    .where("id", "=", row.sessionId)
    .execute();
  return {
    sessionId: row.sessionId,
    memberId: row.memberId,
    centreId: row.centreId,
    kind: row.kind,
    status: row.status,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    companyId: row.companyId,
    companyRole: row.companyRole,
  };
}

export async function deleteMemberSession(db: Kysely<Database>, sessionId: string): Promise<void> {
  await db.deleteFrom("member_sessions").where("id", "=", sessionId).execute();
}

export async function deleteMemberSessions(db: Kysely<Database>, memberId: string): Promise<void> {
  await db.deleteFrom("member_sessions").where("member_id", "=", memberId).execute();
}
