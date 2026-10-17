import { createHash, randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database, Module, Role } from "../db/types.js";

export interface SessionPolicy {
  idleMinutes: number;
  absoluteHours: number;
}

export interface SessionUser {
  sessionId: string;
  userId: string;
  centreId: string;
  email: string;
  fullName: string;
  role: Role;
  modules: Module[];
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** Creates a session and returns the opaque token for the cookie. Only its SHA-256 hash is stored. */
export async function createSession(db: Kysely<Database>, userId: string, policy: SessionPolicy, userAgent: string | undefined): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const absolute = new Date(Date.now() + policy.absoluteHours * 3_600_000);
  await db
    .insertInto("sessions")
    .values({ user_id: userId, token_hash: hashToken(token), absolute_expires_at: absolute, user_agent: userAgent ?? null })
    .execute();
  return token;
}

/**
 * Resolves a token to an active user and slides the idle window. Expired sessions and sessions of
 * deactivated users are deleted, so a role or activation change takes effect on the next request.
 */
export async function resolveSession(db: Kysely<Database>, token: string, policy: SessionPolicy): Promise<SessionUser | undefined> {
  const row = await db
    .selectFrom("sessions")
    .innerJoin("users", "users.id", "sessions.user_id")
    .innerJoin("centres", "centres.id", "users.centre_id")
    .select([
      "sessions.id as sessionId",
      "sessions.last_seen_at as lastSeenAt",
      "sessions.absolute_expires_at as absoluteExpiresAt",
      "users.id as userId",
      "users.centre_id as centreId",
      "users.email",
      "users.full_name as fullName",
      "users.role",
      "users.active",
      "centres.modules",
    ])
    .where("sessions.token_hash", "=", hashToken(token))
    .executeTakeFirst();
  if (!row) return undefined;

  const now = Date.now();
  const idleExpired = now - new Date(row.lastSeenAt).getTime() > policy.idleMinutes * 60_000;
  const absoluteExpired = now >= new Date(row.absoluteExpiresAt).getTime();
  if (idleExpired || absoluteExpired || !row.active) {
    await db.deleteFrom("sessions").where("id", "=", row.sessionId).execute();
    return undefined;
  }
  await db
    .updateTable("sessions")
    .set({ last_seen_at: new Date(now) })
    .where("id", "=", row.sessionId)
    .execute();
  return {
    sessionId: row.sessionId,
    userId: row.userId,
    centreId: row.centreId,
    email: row.email,
    fullName: row.fullName,
    role: row.role,
    modules: row.modules,
  };
}

export async function deleteSession(db: Kysely<Database>, sessionId: string): Promise<void> {
  await db.deleteFrom("sessions").where("id", "=", sessionId).execute();
}

export async function deleteUserSessions(db: Kysely<Database>, userId: string): Promise<void> {
  await db.deleteFrom("sessions").where("user_id", "=", userId).execute();
}
