import { createHash, randomBytes } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { ApiTokenRole, Database } from "../db/types.js";
import type { SessionUser } from "./sessions.js";

/** Every access token starts with this marker, so a leaked one is easy to recognise in logs and scanners. */
export const API_TOKEN_MARKER = "gcf_";
const PREFIX_LENGTH = 12;
/** last_used_at is refreshed at most this often, so a busy integration does not write on every request. */
const LAST_USED_RESOLUTION_SECONDS = 60;

export function hashApiToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export interface NewApiToken {
  centreId: string;
  name: string;
  role: ApiTokenRole;
  readOnly: boolean;
  expiresAt: Date | null;
  createdBy: string;
}

/** Creates a token and returns it in clear with its id. Only its SHA-256 hash is stored. */
export async function createApiToken(db: Kysely<Database>, input: NewApiToken): Promise<{ id: string; token: string; prefix: string }> {
  const token = `${API_TOKEN_MARKER}${randomBytes(32).toString("base64url")}`;
  const prefix = token.slice(0, PREFIX_LENGTH);
  const row = await db
    .insertInto("api_tokens")
    .values({
      centre_id: input.centreId,
      name: input.name,
      role: input.role,
      read_only: input.readOnly,
      token_hash: hashApiToken(token),
      token_prefix: prefix,
      created_by: input.createdBy,
      expires_at: input.expiresAt,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id, token, prefix };
}

/**
 * Resolves a bearer token to the identity it acts with. The token is refused when it is revoked or expired, and
 * when the administrator who created it is no longer an active administrator: a token never outlives the
 * authority of the person who issued it.
 */
export async function resolveApiToken(db: Kysely<Database>, token: string): Promise<SessionUser | undefined> {
  if (!token.startsWith(API_TOKEN_MARKER)) return undefined;
  const row = await db
    .selectFrom("api_tokens")
    .innerJoin("users", "users.id", "api_tokens.created_by")
    .innerJoin("centres", "centres.id", "api_tokens.centre_id")
    .select([
      "api_tokens.id",
      "api_tokens.name",
      "api_tokens.role",
      "api_tokens.read_only as readOnly",
      "api_tokens.centre_id as centreId",
      "api_tokens.expires_at as expiresAt",
      "api_tokens.revoked_at as revokedAt",
      "users.id as userId",
      "users.email",
      "users.role as creatorRole",
      "users.active as creatorActive",
      "users.centre_id as creatorCentreId",
      "centres.modules",
    ])
    .where("api_tokens.token_hash", "=", hashApiToken(token))
    .executeTakeFirst();
  if (!row) return undefined;
  if (row.revokedAt) return undefined;
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return undefined;
  if (!row.creatorActive || row.creatorRole !== "admin" || row.creatorCentreId !== row.centreId) return undefined;

  await db
    .updateTable("api_tokens")
    .set({ last_used_at: new Date() })
    .where("id", "=", row.id)
    .where((eb) => eb.or([eb("last_used_at", "is", null), eb("last_used_at", "<", sql<Date>`now() - make_interval(secs => ${LAST_USED_RESOLUTION_SECONDS})`)]))
    .execute();

  return {
    sessionId: row.id,
    userId: row.userId,
    centreId: row.centreId,
    email: row.email,
    fullName: row.name,
    role: row.role,
    modules: row.modules,
    apiToken: { id: row.id, name: row.name, readOnly: row.readOnly },
  };
}
