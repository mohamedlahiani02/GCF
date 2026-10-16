import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { ZodError } from "zod";
import { can, type Permission } from "./auth/permissions.js";
import { resolveMemberSession, type MemberSession } from "./auth/memberSessions.js";
import { resolveSession, type SessionUser } from "./auth/sessions.js";
import type { Config } from "./config.js";
import type { Database } from "./db/types.js";
import { createMailer, type Mailer } from "./mail.js";
import { forbidden, HttpError, unauthenticated } from "./errors.js";
import { accountRoutes } from "./routes/accounts.js";
import { auditRoutes } from "./routes/audit.js";
import { authRoutes } from "./routes/auth.js";
import { cashRoutes } from "./routes/cash.js";
import { catalogueRoutes } from "./routes/catalogue.js";
import { centreRoutes } from "./routes/centre.js";
import { coworkingBookingRoutes } from "./routes/coworking/bookings.js";
import { coworkingConfigRoutes } from "./routes/coworking/config.js";
import { coworkingMemberRoutes } from "./routes/coworking/members.js";
import { mediaRoutes } from "./routes/media.js";
import { portalRoutes } from "./routes/portal/index.js";
import { publicRoutes } from "./routes/public.js";
import { websiteRoutes } from "./routes/website.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { enrolmentRoutes } from "./routes/enrolments.js";
import { groupRoutes } from "./routes/groups.js";
import { instructorRoutes } from "./routes/instructors.js";
import { paymentRoutes } from "./routes/payments.js";
import { payrollRoutes } from "./routes/payroll.js";
import { receiptRoutes } from "./routes/receipts.js";
import { rentalRoutes } from "./routes/rentals.js";
import { reportRoutes } from "./routes/reports.js";
import { searchRoutes } from "./routes/search.js";
import { sessionRoutes } from "./routes/sessions.js";
import { studentRoutes } from "./routes/students.js";
import { userRoutes } from "./routes/users.js";
import { isPublicHost } from "./publicCentre.js";
import { handlePublicGet } from "./site/publicSurface.js";

export const SESSION_COOKIE = "gcf_session";
/** Portal sessions of coworking clients; never accepted by back-office routes. */
export const MEMBER_COOKIE = "gcf_member";

declare module "fastify" {
  interface FastifyInstance {
    db: Kysely<Database>;
    config: Config;
    requirePermission(permission: Permission): (request: FastifyRequest) => Promise<void>;
    mailer: Mailer | null;
  }
  interface FastifyRequest {
    user: SessionUser | null;
    member: MemberSession | null;
  }
}

export interface AppOptions {
  config: Config;
  db: Kysely<Database>;
  rateLimit?: boolean;
  /** Overrides the SMTP mailer built from the configuration (used by tests). */
  mailer?: Mailer | null;
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** API areas called by the public surface (portal and website forms) instead of the back-office. */
const isPublicApi = (url: string) => url.startsWith("/api/portal/") || url.startsWith("/api/public/");

/** Maps PostgreSQL integrity errors to client errors; everything else is a 500 that is logged. */
function mapDatabaseError(error: unknown): HttpError | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code: unknown }).code;
  const constraint = (error as { constraint?: string }).constraint;
  if (code === "23505") return new HttpError(409, "duplicate", "this value already exists", { constraint });
  if (code === "23514") return new HttpError(422, "constraint_violation", "a business rule was violated", { constraint });
  if (code === "23503") return new HttpError(422, "invalid_reference", "a referenced record does not exist", { constraint });
  return undefined;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { config, db } = options;
  const app = Fastify({
    logger: config.logLevel === "silent" ? false : { level: config.logLevel, redact: ["req.headers.cookie", "body.password"] },
    trustProxy: true,
  });

  app.decorate("db", db);
  app.decorate("config", config);
  app.decorate("mailer", options.mailer === undefined ? createMailer(config) : options.mailer);
  app.decorateRequest("user", null);
  app.decorateRequest("member", null);

  await app.register(helmet);
  await app.register(cookie);
  if (options.rateLimit !== false) await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  // CSRF defence in depth: SameSite=Strict cookies plus an Origin check on every state-changing request. The
  // portal and the website forms are called from the public origin, everything else from the back-office.
  app.addHook("onRequest", async (request) => {
    if (!UNSAFE_METHODS.has(request.method)) return;
    const expected = isPublicApi(request.url) ? config.publicOrigin : config.webOrigin;
    if (!expected || request.headers.origin !== expected) throw new HttpError(403, "bad_origin", "request origin is not allowed");
  });

  app.addHook("onRequest", async (request) => {
    if (request.url.startsWith("/api/portal/")) {
      const memberToken = request.cookies[MEMBER_COOKIE];
      if (memberToken) {
        request.member =
          (await resolveMemberSession(db, memberToken, {
            idleMinutes: config.memberSessionIdleMinutes,
            absoluteHours: config.memberSessionAbsoluteHours,
          })) ?? null;
      }
      return;
    }
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    request.user =
      (await resolveSession(db, token, {
        idleMinutes: config.sessionIdleMinutes,
        absoluteHours: config.sessionAbsoluteHours,
      })) ?? null;
  });

  app.decorate("requirePermission", (permission: Permission) => async (request: FastifyRequest) => {
    if (!request.user) throw unauthenticated();
    if (!can(request.user, permission)) throw forbidden();
  });

  app.setErrorHandler((error, request, reply: FastifyReply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        code: "invalid_input",
        message: "the request is invalid",
        details: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const httpError = error instanceof HttpError ? error : mapDatabaseError(error);
    if (httpError) {
      return reply.status(httpError.statusCode).send({
        code: httpError.code,
        message: httpError.message,
        ...(httpError.details === undefined ? {} : { details: httpError.details }),
      });
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({ code: "bad_request", message: (error as Error).message });
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send({ code: "internal_error", message: "an unexpected error occurred" });
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(centreRoutes, { prefix: "/api/centre" });
  await app.register(userRoutes, { prefix: "/api/users" });
  await app.register(studentRoutes, { prefix: "/api/students" });
  await app.register(auditRoutes, { prefix: "/api/audit-log" });
  await app.register(catalogueRoutes, { prefix: "/api/catalogue" });
  await app.register(instructorRoutes, { prefix: "/api/instructors" });
  await app.register(groupRoutes, { prefix: "/api/groups" });
  await app.register(enrolmentRoutes, { prefix: "/api/enrolments" });
  await app.register(sessionRoutes, { prefix: "/api" });
  await app.register(paymentRoutes, { prefix: "/api/payments" });
  await app.register(receiptRoutes, { prefix: "/api/receipts" });
  await app.register(accountRoutes, { prefix: "/api" });
  await app.register(payrollRoutes, { prefix: "/api/payroll" });
  await app.register(rentalRoutes, { prefix: "/api" });
  await app.register(cashRoutes, { prefix: "/api/cash" });
  await app.register(reportRoutes, { prefix: "/api/reports" });
  await app.register(dashboardRoutes, { prefix: "/api/dashboard" });
  await app.register(searchRoutes, { prefix: "/api/search" });
  await app.register(mediaRoutes, { prefix: "/api/media" });
  await app.register(coworkingConfigRoutes, { prefix: "/api/coworking" });
  await app.register(coworkingMemberRoutes, { prefix: "/api/coworking" });
  await app.register(coworkingBookingRoutes, { prefix: "/api/coworking" });
  await app.register(websiteRoutes, { prefix: "/api/site" });
  await app.register(portalRoutes, { prefix: "/api/portal" });
  await app.register(publicRoutes, { prefix: "/api/public" });

  if (config.webDistDir) {
    const root = path.resolve(config.webDistDir);
    const assets = path.join(root, "assets");
    await app.register(fastifyStatic, {
      root,
      wildcard: false,
      index: false,
      setHeaders: (reply, filePath) => {
        // Vite fingerprints everything under assets/, so those files never change; index.html must always be revalidated.
        reply.header("cache-control", filePath.startsWith(assets) ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== "GET" || request.url === "/api" || request.url.startsWith("/api/")) {
        return reply.status(404).send({ code: "not_found", message: "route not found" });
      }
      if (isPublicHost(request, config)) return handlePublicGet(app, request, reply);
      return reply.sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/") && isPublicHost(request, config)) return handlePublicGet(app, request, reply);
      return reply.status(404).send({ code: "not_found", message: "route not found" });
    });
  }
  return app;
}
