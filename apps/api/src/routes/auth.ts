import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { SESSION_COOKIE } from "../app.js";
import { writeAudit } from "../audit.js";
import { hashPassword, PASSWORD_MIN_LENGTH, verifyPassword } from "../auth/passwords.js";
import { permissionsOf } from "../auth/permissions.js";
import { createSession, deleteSession, deleteUserSessions } from "../auth/sessions.js";
import { HttpError, unauthenticated } from "../errors.js";

const loginBody = z.object({
  email: z.string().trim().toLowerCase().min(3).max(254),
  password: z.string().min(1).max(1024),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(1024),
});

const invalidCredentials = () => new HttpError(401, "invalid_credentials", "email or password is incorrect");

export const authRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app;

  app.post("/login", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = loginBody.parse(request.body);
    const user = await db.selectFrom("users").selectAll().where("email", "=", body.email).executeTakeFirst();
    if (!user || !user.active) {
      // Same answer whether the account exists or not.
      throw invalidCredentials();
    }
    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      throw new HttpError(423, "account_locked", "too many failed attempts, try again later", {
        lockedUntil: user.locked_until.toISOString(),
      });
    }
    const ok = await verifyPassword(user.password_hash, body.password);
    const centre = await db.selectFrom("centres").select("modules").where("id", "=", user.centre_id).executeTakeFirstOrThrow();
    if (!ok) {
      const failures = user.failed_login_count + 1;
      const lock = failures >= config.loginMaxFailures;
      await db
        .updateTable("users")
        .set({
          failed_login_count: lock ? 0 : failures,
          locked_until: lock ? new Date(Date.now() + config.loginLockMinutes * 60_000) : null,
        })
        .where("id", "=", user.id)
        .execute();
      throw invalidCredentials();
    }
    await db.updateTable("users").set({ failed_login_count: 0, locked_until: null, last_login_at: new Date() }).where("id", "=", user.id).execute();
    const token = await createSession(
      db,
      user.id,
      { idleMinutes: config.sessionIdleMinutes, absoluteHours: config.sessionAbsoluteHours },
      request.headers["user-agent"],
    );
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: "strict",
      path: "/",
    });
    return {
      user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role },
      permissions: permissionsOf({ role: user.role, modules: centre.modules }),
      modules: centre.modules,
    };
  });

  app.post("/logout", async (request, reply) => {
    if (request.user) await deleteSession(db, request.user.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.status(204).send();
  });

  app.get("/session", async (request) => {
    const user = request.user;
    if (!user) throw unauthenticated();
    return {
      user: { id: user.userId, email: user.email, fullName: user.fullName, role: user.role },
      permissions: permissionsOf(user),
      modules: user.modules,
    };
  });

  app.post("/password", async (request, reply) => {
    const user = request.user;
    if (!user) throw unauthenticated();
    const body = changePasswordBody.parse(request.body);
    const row = await db.selectFrom("users").select("password_hash").where("id", "=", user.userId).executeTakeFirstOrThrow();
    if (!(await verifyPassword(row.password_hash, body.currentPassword))) throw invalidCredentials();
    const hash = await hashPassword(body.newPassword);
    await db.transaction().execute(async (trx) => {
      await trx.updateTable("users").set({ password_hash: hash, updated_at: new Date() }).where("id", "=", user.userId).execute();
      await writeAudit(trx, {
        centreId: user.centreId,
        userId: user.userId,
        action: "user.password_changed",
        objectType: "user",
        objectId: user.userId,
      });
    });
    // Every other device is signed out; this session stays.
    await deleteUserSessions(db, user.userId);
    const token = await createSession(
      db,
      user.userId,
      { idleMinutes: config.sessionIdleMinutes, absoluteHours: config.sessionAbsoluteHours },
      request.headers["user-agent"],
    );
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, secure: config.cookieSecure, sameSite: "strict", path: "/" });
    return reply.status(204).send();
  });
};
