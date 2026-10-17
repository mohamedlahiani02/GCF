import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { MEMBER_COOKIE } from "../../app.js";
import { createMemberSession, type MemberSession } from "../../auth/memberSessions.js";
import type { Config } from "../../config.js";
import type { Database } from "../../db/types.js";
import { coworkingSettings, type CoworkingSettings } from "../../domain/coworking/schedule.js";
import { HttpError, unauthenticated } from "../../errors.js";
import { publicCentre, type PublicCentre } from "../../publicCentre.js";

export const portalUnavailable = () => new HttpError(404, "portal_unavailable", "the client portal is not available");

export interface Portal {
  centre: PublicCentre;
  settings: CoworkingSettings;
}

/** The public centre with its coworking settings, or 404 portal_unavailable when it does not run the client portal. */
export async function openPortal(db: Kysely<Database>): Promise<Portal> {
  const centre = await publicCentre(db);
  if (!centre.modules.includes("coworking")) throw portalUnavailable();
  const settings = await coworkingSettings(db, centre.id);
  if (!settings.portal_enabled) throw portalUnavailable();
  return { centre, settings };
}

export interface SignedIn extends Portal {
  member: MemberSession;
}

/** The open portal and the member signed in to it: an active account of the public centre, otherwise 401. */
export async function signedIn(db: Kysely<Database>, request: FastifyRequest): Promise<SignedIn> {
  const portal = await openPortal(db);
  const member = request.member;
  if (!member || member.status !== "active" || member.centreId !== portal.centre.id) throw unauthenticated();
  return { ...portal, member };
}

/** Opens a portal session for a member and sets its cookie, with the same options as the staff session cookie. */
export async function startMemberSession(db: Kysely<Database>, config: Config, request: FastifyRequest, reply: FastifyReply, memberId: string): Promise<void> {
  const token = await createMemberSession(
    db,
    memberId,
    { idleMinutes: config.memberSessionIdleMinutes, absoluteHours: config.memberSessionAbsoluteHours },
    request.headers["user-agent"],
  );
  await db.updateTable("members").set({ last_login_at: new Date() }).where("id", "=", memberId).execute();
  reply.setCookie(MEMBER_COOKIE, token, { httpOnly: true, secure: config.cookieSecure, sameSite: "strict", path: "/" });
}

/** What the portal shows of the signed-in member's own account. */
export async function memberProfile(db: Kysely<Database>, memberId: string) {
  const row = await db
    .selectFrom("members")
    .leftJoin("companies", "companies.id", "members.company_id")
    .select([
      "members.id",
      "members.email",
      "members.first_name as firstName",
      "members.last_name as lastName",
      "members.phone",
      "members.email_verified_at as emailVerifiedAt",
      "members.company_id as companyId",
      "companies.name as companyName",
      "members.company_role as companyRole",
    ])
    .where("members.id", "=", memberId)
    .executeTakeFirstOrThrow();
  const { companyId, companyName, companyRole, emailVerifiedAt, ...member } = row;
  return {
    member: {
      ...member,
      emailVerified: emailVerifiedAt !== null,
      company: companyId ? { id: companyId, name: companyName!, role: companyRole! } : null,
    },
  };
}
