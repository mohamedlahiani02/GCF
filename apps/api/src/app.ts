import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { ZodError } from "zod";
import { can, type Permission } from "./auth/permissions.js";
import { resolveSession, type SessionUser } from "./auth/sessions.js";
import type { Config } from "./config.js";
import type { Database } from "./db/types.js";
import { forbidden, HttpError, unauthenticated } from "./errors.js";
import { auditRoutes } from "./routes/audit.js";
import { authRoutes } from "./routes/auth.js";
import { catalogueRoutes } from "./routes/catalogue.js";
import { centreRoutes } from "./routes/centre.js";
import { enrolmentRoutes } from "./routes/enrolments.js";
import { groupRoutes } from "./routes/groups.js";
import { instructorRoutes } from "./routes/instructors.js";
import { sessionRoutes } from "./routes/sessions.js";
import { studentRoutes } from "./routes/students.js";
import { userRoutes } from "./routes/users.js";

export const SESSION_COOKIE = "gcf_session";

declare module "fastify" {
  interface FastifyInstance {
    db: Kysely<Database>;
    config: Config;
    requirePermission(permission: Permission): (request: FastifyRequest) => Promise<void>;
  }
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export interface AppOptions {
  config: Config;
  db: Kysely<Database>;
  rateLimit?: boolean;
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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
  app.decorateRequest("user", null);

  await app.register(helmet);
  await app.register(cookie);
  if (options.rateLimit !== false) await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  // CSRF defence in depth: SameSite=Strict cookies plus an Origin check on every state-changing request.
  app.addHook("onRequest", async (request) => {
    if (!UNSAFE_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    if (origin !== config.webOrigin) throw new HttpError(403, "bad_origin", "request origin is not allowed");
  });

  app.addHook("onRequest", async (request) => {
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
    if (!can(request.user.role, permission)) throw forbidden();
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
  return app;
}
