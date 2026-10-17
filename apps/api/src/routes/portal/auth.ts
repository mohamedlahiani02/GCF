import { SITE_LANGUAGES } from "@gcf/shared";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { MEMBER_COOKIE } from "../../app.js";
import { writeAudit } from "../../audit.js";
import { deleteMemberSession, deleteMemberSessions } from "../../auth/memberSessions.js";
import { consumeMemberToken, issueMemberToken, MEMBER_TOKEN_TTL_MINUTES, type MemberTokenPurpose } from "../../auth/memberTokens.js";
import { hashPassword, PASSWORD_MIN_LENGTH, verifyPassword } from "../../auth/passwords.js";
import { portalLink, sendMemberMail } from "../../domain/coworking/memberMail.js";
import { centreCalendar, coworkingSettings } from "../../domain/coworking/schedule.js";
import { conflict, HttpError, notFound, unprocessable } from "../../errors.js";
import { publicCentre } from "../../publicCentre.js";
import { optionalText, requiredText } from "../../validation.js";
import { memberProfile, openPortal, portalUnavailable, signedIn, startMemberSession } from "./context.js";

const email = z.string().trim().toLowerCase().email().max(254);
const newPassword = z.string().min(PASSWORD_MIN_LENGTH).max(1024);

const loginBody = z.object({ email: z.string().trim().toLowerCase().min(3).max(254), password: z.string().min(1).max(1024) }).strict();
const signupBody = z
  .object({
    email,
    password: newPassword,
    firstName: requiredText(100),
    lastName: requiredText(100),
    phone: requiredText(40),
    companyName: optionalText(150),
  })
  .strict();
const forgotBody = z.object({ email: z.string().trim().toLowerCase().min(3).max(254) }).strict();
const tokenBody = z.object({ token: z.string().min(1).max(200), password: newPassword }).strict();
const profileBody = z
  .object({ firstName: requiredText(100), lastName: requiredText(100), phone: requiredText(40) })
  .partial()
  .strict();
const changePasswordBody = z.object({ currentPassword: z.string().min(1).max(1024), newPassword }).strict();

/** Same limit as the staff login: these endpoints are the ones worth hammering. */
const throttled = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

const invalidCredentials = () => new HttpError(401, "invalid_credentials", "email or password is incorrect");
const invalidToken = () => unprocessable("invalid_token", "this link is invalid, expired or already used");

/** Portal identity: centre information, sign-up, sign-in, password links and the member's own profile. */
export const portalAuthRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app;

  /**
   * What the portal needs before anyone signs in. It also answers while the portal is switched off (portalEnabled
   * false), so the client can show a closed page with the centre's name and colours instead of a bare error.
   */
  app.get("/info", async () => {
    const centre = await publicCentre(db);
    if (!centre.modules.includes("coworking")) throw portalUnavailable();
    const settings = await coworkingSettings(db, centre.id);
    const row = await db.selectFrom("centres").select(["name", "address", "logo_updated_at"]).where("id", "=", centre.id).executeTakeFirstOrThrow();
    const site = centre.modules.includes("website")
      ? await db.selectFrom("site_settings").select(["primary_color", "secondary_color", "logo_media_id"]).where("centre_id", "=", centre.id).executeTakeFirst()
      : undefined;
    const calendar = await centreCalendar(db, centre.id);
    return {
      portalEnabled: settings.portal_enabled,
      centre: { name: row.name, address: row.address },
      logoUrl: site?.logo_media_id ? `/media/${site.logo_media_id}` : row.logo_updated_at ? `/api/portal/logo?v=${row.logo_updated_at.getTime()}` : null,
      selfSignup: settings.self_signup,
      languages: SITE_LANGUAGES,
      colors: site ? { primary: site.primary_color, secondary: site.secondary_color } : null,
      openingHours: { from: calendar.openFrom, to: calendar.openTo, weekdays: calendar.openWeekdays },
      timezone: calendar.timezone,
    };
  });

  /** The centre's own logo, used when the website module gives none. The URL carries its version, so it is cached for good. */
  app.get("/logo", async (_request, reply) => {
    const centre = await publicCentre(db);
    if (!centre.modules.includes("coworking")) throw portalUnavailable();
    const row = await db.selectFrom("centres").select(["logo", "logo_mime"]).where("id", "=", centre.id).executeTakeFirstOrThrow();
    if (!row.logo || !row.logo_mime) throw notFound("logo");
    return reply.header("content-type", row.logo_mime).header("cache-control", "public, max-age=31536000, immutable").send(row.logo);
  });

  /**
   * Self sign-up. "open" creates an active account and signs it in; "validated" creates a pending account the
   * staff validates; "closed" refuses. A company name creates the company when no company of the centre has that
   * name yet; an existing name is never joined from the portal (anyone could claim to belong to it), so the
   * account is left without a company and the staff attaches it.
   */
  app.post("/auth/signup", throttled, async (request, reply) => {
    const { centre, settings } = await openPortal(db);
    if (settings.self_signup === "closed") throw new HttpError(403, "signup_closed", "sign-up is closed: ask the front desk for an invitation");
    const body = signupBody.parse(request.body);
    const status = settings.self_signup === "open" ? "active" : "pending";
    const passwordHash = await hashPassword(body.password);
    const memberId = await db.transaction().execute(async (trx) => {
      const taken = await trx.selectFrom("members").select("id").where("email", "=", body.email).executeTakeFirst();
      if (taken) throw conflict("email_taken", "another client already uses this e-mail address");
      let companyId: string | null = null;
      if (body.companyName) {
        const existing = await trx
          .selectFrom("companies")
          .select("id")
          .where("centre_id", "=", centre.id)
          .where(sql`lower(name)`, "=", body.companyName.toLowerCase())
          .executeTakeFirst();
        if (!existing) {
          const company = await trx
            .insertInto("companies")
            .values({ centre_id: centre.id, name: body.companyName, tax_id: null, address: null, email: null, phone: null, status: "active", created_by: null })
            .returning("id")
            .executeTakeFirstOrThrow();
          companyId = company.id;
        }
      }
      const created = await trx
        .insertInto("members")
        .values({
          centre_id: centre.id,
          kind: "member",
          first_name: body.firstName,
          last_name: body.lastName,
          email: body.email,
          phone: body.phone,
          company_id: companyId,
          company_role: companyId ? "member" : null,
          status,
          password_hash: passwordHash,
          notes: null,
          created_by: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      if (companyId) {
        await writeAudit(trx, {
          centreId: centre.id,
          userId: null,
          action: "company.created",
          objectType: "company",
          objectId: companyId,
          after: { name: body.companyName, source: "portal", memberId: created.id },
        });
      }
      await writeAudit(trx, {
        centreId: centre.id,
        userId: null,
        action: "member.signed_up",
        objectType: "member",
        objectId: created.id,
        after: {
          source: "portal",
          memberId: created.id,
          email: body.email,
          firstName: body.firstName,
          lastName: body.lastName,
          phone: body.phone,
          status,
          companyName: body.companyName ?? null,
          companyId,
        },
      });
      return created.id;
    });
    if (status === "pending") return reply.status(201).send({ status });
    await startMemberSession(db, config, request, reply, memberId);
    return reply.status(201).send({ status, ...(await memberProfile(db, memberId)) });
  });

  /** Same checks, lockout and answers as the staff login; a pending account with the right password gets 403 account_pending. */
  app.post("/auth/login", throttled, async (request, reply) => {
    const { centre } = await openPortal(db);
    const body = loginBody.parse(request.body);
    const member = await db
      .selectFrom("members")
      .select(["id", "centre_id", "kind", "status", "password_hash", "failed_login_count", "locked_until"])
      .where("email", "=", body.email)
      .executeTakeFirst();
    if (!member || member.centre_id !== centre.id || member.kind !== "member" || member.status === "disabled" || !member.password_hash) {
      // Same answer whether the account exists or not.
      throw invalidCredentials();
    }
    if (member.locked_until && member.locked_until.getTime() > Date.now()) {
      throw new HttpError(423, "account_locked", "too many failed attempts, try again later", { lockedUntil: member.locked_until.toISOString() });
    }
    if (!(await verifyPassword(member.password_hash, body.password))) {
      const failures = member.failed_login_count + 1;
      const lock = failures >= config.loginMaxFailures;
      await db
        .updateTable("members")
        .set({
          failed_login_count: lock ? 0 : failures,
          locked_until: lock ? new Date(Date.now() + config.loginLockMinutes * 60_000) : null,
        })
        .where("id", "=", member.id)
        .execute();
      throw invalidCredentials();
    }
    await db.updateTable("members").set({ failed_login_count: 0, locked_until: null }).where("id", "=", member.id).execute();
    if (member.status === "pending") throw new HttpError(403, "account_pending", "the account is waiting for validation by the centre");
    await startMemberSession(db, config, request, reply, member.id);
    return memberProfile(db, member.id);
  });

  app.post("/auth/logout", async (request, reply) => {
    await openPortal(db);
    if (request.member) await deleteMemberSession(db, request.member.sessionId);
    reply.clearCookie(MEMBER_COOKIE, { path: "/" });
    return reply.status(204).send();
  });

  app.get("/auth/session", async (request) => {
    const { member } = await signedIn(db, request);
    return memberProfile(db, member.memberId);
  });

  /** Always 204, so the answer never tells whether an address has an account. */
  app.post("/auth/forgot", throttled, async (request, reply) => {
    const { centre } = await openPortal(db);
    const body = forgotBody.parse(request.body);
    const member = await db
      .selectFrom("members")
      .select(["id", "first_name", "email"])
      .where("email", "=", body.email)
      .where("centre_id", "=", centre.id)
      .where("kind", "=", "member")
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!member || !member.email || !config.publicOrigin) return reply.status(204).send();
    const issued = await db.transaction().execute(async (trx) => {
      const token = await issueMemberToken(trx, member.id, "password_reset");
      await writeAudit(trx, {
        centreId: centre.id,
        userId: null,
        action: "member.password_reset_requested",
        objectType: "member",
        objectId: member.id,
        after: { source: "portal", memberId: member.id, expiresAt: token.expiresAt },
      });
      return token;
    });
    const centreName = (await db.selectFrom("centres").select("name").where("id", "=", centre.id).executeTakeFirstOrThrow()).name;
    const link = portalLink(config.publicOrigin, `/mot-de-passe?token=${encodeURIComponent(issued.token)}`);
    await sendMemberMail(db, app.mailer, request.log, {
      centreId: centre.id,
      memberId: member.id,
      kind: "password_reset",
      to: member.email,
      subject: `${centreName} : nouveau mot de passe / new password`,
      text: [
        `Bonjour ${member.first_name},`,
        "",
        `Pour choisir un nouveau mot de passe pour votre espace client, ouvrez ce lien (valable ${MEMBER_TOKEN_TTL_MINUTES.password_reset} minutes) :`,
        `${link}`,
        "",
        "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe reste inchangé.",
        "",
        `To choose a new password for your client area, open the link above (valid for ${MEMBER_TOKEN_TTL_MINUTES.password_reset} minutes). If you did not ask for it, ignore this message.`,
        "",
        centreName,
      ].join("\n"),
      sentBy: null,
    });
    return reply.status(204).send();
  });

  /**
   * Sets the password from an e-mailed link, signs every other device out and opens a session. The link proves the
   * member owns the address, so the address counts as verified.
   */
  async function setPasswordFromLink(request: FastifyRequest, reply: FastifyReply, purpose: MemberTokenPurpose, action: string) {
    const { centre } = await openPortal(db);
    const body = tokenBody.parse(request.body);
    const passwordHash = await hashPassword(body.password);
    const memberId = await db.transaction().execute(async (trx) => {
      const consumed = await consumeMemberToken(trx, body.token, purpose);
      if (!consumed) throw invalidToken();
      const member = await trx
        .selectFrom("members")
        .select(["id", "centre_id", "kind", "status"])
        .where("id", "=", consumed.memberId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (member.centre_id !== centre.id || member.kind !== "member" || member.status !== "active") throw invalidToken();
      const now = new Date();
      await trx
        .updateTable("members")
        .set({
          password_hash: passwordHash,
          email_verified_at: sql<Date>`coalesce(email_verified_at, ${now})`,
          failed_login_count: 0,
          locked_until: null,
          updated_at: now,
        })
        .where("id", "=", member.id)
        .execute();
      await deleteMemberSessions(trx, member.id);
      await writeAudit(trx, {
        centreId: centre.id,
        userId: null,
        action,
        objectType: "member",
        objectId: member.id,
        after: { source: "portal", memberId: member.id },
      });
      return member.id;
    });
    await startMemberSession(db, config, request, reply, memberId);
    return memberProfile(db, memberId);
  }

  app.post("/auth/reset", throttled, (request, reply) => setPasswordFromLink(request, reply, "password_reset", "member.password_reset"));
  app.post("/auth/activate", throttled, (request, reply) => setPasswordFromLink(request, reply, "activation", "member.activated"));

  /** The member's own name and phone; the e-mail address identifies the account and is changed by the staff. */
  app.patch("/me", async (request) => {
    const { centre, member } = await signedIn(db, request);
    const body = profileBody.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom("members")
        .select(["first_name as firstName", "last_name as lastName", "phone"])
        .where("id", "=", member.memberId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      await trx
        .updateTable("members")
        .set({
          ...(body.firstName === undefined ? {} : { first_name: body.firstName }),
          ...(body.lastName === undefined ? {} : { last_name: body.lastName }),
          ...(body.phone === undefined ? {} : { phone: body.phone }),
          updated_at: new Date(),
        })
        .where("id", "=", member.memberId)
        .execute();
      await writeAudit(trx, {
        centreId: centre.id,
        userId: null,
        action: "member.updated",
        objectType: "member",
        objectId: member.memberId,
        before,
        after: { source: "portal", memberId: member.memberId, ...body },
      });
    });
    return memberProfile(db, member.memberId);
  });

  /** Like the staff password change: every other device is signed out and this one gets a new session. */
  app.post("/me/password", async (request, reply) => {
    const { centre, member } = await signedIn(db, request);
    const body = changePasswordBody.parse(request.body);
    const row = await db.selectFrom("members").select("password_hash").where("id", "=", member.memberId).executeTakeFirstOrThrow();
    if (!row.password_hash || !(await verifyPassword(row.password_hash, body.currentPassword))) throw invalidCredentials();
    const hash = await hashPassword(body.newPassword);
    await db.transaction().execute(async (trx) => {
      await trx.updateTable("members").set({ password_hash: hash, updated_at: new Date() }).where("id", "=", member.memberId).execute();
      await writeAudit(trx, {
        centreId: centre.id,
        userId: null,
        action: "member.password_changed",
        objectType: "member",
        objectId: member.memberId,
        after: { source: "portal", memberId: member.memberId },
      });
      await deleteMemberSessions(trx, member.memberId);
    });
    await startMemberSession(db, config, request, reply, member.memberId);
    return reply.status(204).send();
  });
};
