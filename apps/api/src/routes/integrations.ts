import type { FastifyPluginAsync } from "fastify";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { createApiToken } from "../auth/apiTokens.js";
import type { Database } from "../db/types.js";
import { EVENT_PATTERN, newWebhookSecret, pingEndpoint } from "../domain/webhooks.js";
import { notFound, unprocessable } from "../errors.js";

const idParam = z.object({ id: z.string().uuid() });

const tokenBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    role: z.enum(["secretariat", "accountant", "editor"]),
    readOnly: z.boolean().default(true),
    expiresAt: z.iso.datetime({ offset: true }).nullable().default(null),
  })
  .strict();

const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "the address must start with http:// or https://");
const events = z
  .array(z.string().trim().regex(EVENT_PATTERN, "an event is an action such as payment.created, a family such as payment.*, or *"))
  .min(1)
  .max(100)
  .refine((list) => new Set(list).size === list.length, "each event may only be listed once");
const endpointBody = z
  .object({ name: z.string().trim().min(1).max(100), url: httpUrl, events, maxAttempts: z.number().int().min(1).max(20).default(10) })
  .strict();
const endpointPatch = z
  .object({ name: z.string().trim().min(1).max(100), url: httpUrl, events, maxAttempts: z.number().int().min(1).max(20), active: z.boolean() })
  .partial()
  .strict();
const deliveriesQuery = z.object({
  status: z.enum(["pending", "delivered", "failed"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** How far back the audit log is read to suggest event names. */
const EVENT_SUGGESTION_DAYS = 365;

type TokenState = "active" | "expired" | "revoked";

const tokenState = (t: { revokedAt: Date | null; expiresAt: Date | null }): TokenState =>
  t.revokedAt ? "revoked" : t.expiresAt && new Date(t.expiresAt).getTime() <= Date.now() ? "expired" : "active";

async function loadTokens(db: Kysely<Database>, centreId: string, id?: string) {
  let query = db
    .selectFrom("api_tokens")
    .innerJoin("users", "users.id", "api_tokens.created_by")
    .select([
      "api_tokens.id",
      "api_tokens.name",
      "api_tokens.role",
      "api_tokens.read_only as readOnly",
      "api_tokens.token_prefix as prefix",
      "api_tokens.created_at as createdAt",
      "users.full_name as createdByName",
      "api_tokens.expires_at as expiresAt",
      "api_tokens.last_used_at as lastUsedAt",
      "api_tokens.revoked_at as revokedAt",
    ])
    .where("api_tokens.centre_id", "=", centreId);
  if (id) query = query.where("api_tokens.id", "=", id);
  const rows = await query.orderBy("api_tokens.created_at", "desc").execute();
  return rows.map((r) => ({ ...r, state: tokenState(r) }));
}

async function loadEndpoints(db: Kysely<Database>, centreId: string, id?: string) {
  let query = db
    .selectFrom("webhook_endpoints as e")
    .select([
      "e.id",
      "e.name",
      "e.url",
      "e.events",
      "e.active",
      "e.max_attempts as maxAttempts",
      "e.created_at as createdAt",
      "e.updated_at as updatedAt",
      sql<number>`(select count(*) from webhook_deliveries d where d.endpoint_id = e.id and d.status = 'pending')::int`.as("pending"),
      sql<number>`(select count(*) from webhook_deliveries d where d.endpoint_id = e.id and d.status = 'failed')::int`.as("failed"),
      sql<Date | null>`(select max(d.delivered_at) from webhook_deliveries d where d.endpoint_id = e.id)`.as("lastDeliveredAt"),
    ])
    .where("e.centre_id", "=", centreId);
  if (id) query = query.where("e.id", "=", id);
  return query.orderBy("e.created_at").execute();
}

/**
 * Access tokens and webhooks, for the administrator. Secrets are shown once: a token at its creation, a webhook
 * secret at the creation of its endpoint and at each rotation. They never appear in the audit log.
 */
export const integrationRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app;
  const manage = app.requirePermission("centre:manage");

  app.get("/tokens", { preHandler: manage }, async (request) => loadTokens(db, request.user!.centreId));

  app.post("/tokens", { preHandler: manage }, async (request, reply) => {
    const actor = request.user!;
    const body = tokenBody.parse(request.body);
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) throw unprocessable("expiry_in_past", "the expiry date must be in the future");
    const created = await createApiToken(db, {
      centreId: actor.centreId,
      name: body.name,
      role: body.role,
      readOnly: body.readOnly,
      expiresAt,
      createdBy: actor.userId,
    });
    await writeAudit(db, {
      centreId: actor.centreId,
      userId: actor.userId,
      action: "api_token.created",
      objectType: "api_token",
      objectId: created.id,
      after: { name: body.name, role: body.role, readOnly: body.readOnly, expiresAt: body.expiresAt, prefix: created.prefix },
    });
    const [token] = await loadTokens(db, actor.centreId, created.id);
    return reply.status(201).send({ ...token, token: created.token });
  });

  app.post("/tokens/:id/revoke", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    await db.transaction().execute(async (trx) => {
      const revoked = await trx
        .updateTable("api_tokens")
        .set({ revoked_at: new Date(), revoked_by: actor.userId })
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .where("revoked_at", "is", null)
        .returning("name")
        .executeTakeFirst();
      if (!revoked) {
        const exists = await trx.selectFrom("api_tokens").select("id").where("id", "=", id).where("centre_id", "=", actor.centreId).executeTakeFirst();
        if (!exists) throw notFound("access token");
        throw unprocessable("already_revoked", "this access token is already revoked");
      }
      await writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action: "api_token.revoked", objectType: "api_token", objectId: id });
    });
    const [token] = await loadTokens(db, actor.centreId, id);
    return token;
  });

  app.get("/events", { preHandler: manage }, async (request) => {
    const rows = await db
      .selectFrom("audit_log")
      .select("action")
      .distinct()
      .where("centre_id", "=", request.user!.centreId)
      .where("at", ">=", sql<Date>`now() - make_interval(days => ${EVENT_SUGGESTION_DAYS})`)
      .orderBy("action")
      .execute();
    return { actions: rows.map((r) => r.action) };
  });

  app.get("/webhooks", { preHandler: manage }, async (request) => loadEndpoints(db, request.user!.centreId));

  app.post("/webhooks", { preHandler: manage }, async (request, reply) => {
    const actor = request.user!;
    const body = endpointBody.parse(request.body);
    const secret = newWebhookSecret();
    const id = await db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto("webhook_endpoints")
        .values({
          centre_id: actor.centreId,
          name: body.name,
          url: body.url,
          secret,
          events: body.events,
          max_attempts: body.maxAttempts,
          created_by: actor.userId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "webhook_endpoint.created",
        objectType: "webhook_endpoint",
        objectId: created.id,
        after: body,
      });
      return created.id;
    });
    const [endpoint] = await loadEndpoints(db, actor.centreId, id);
    return reply.status(201).send({ ...endpoint, secret });
  });

  app.patch("/webhooks/:id", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = endpointPatch.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom("webhook_endpoints")
        .select(["name", "url", "events", "max_attempts as maxAttempts", "active"])
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw notFound("webhook");
      await trx
        .updateTable("webhook_endpoints")
        .set({
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.url === undefined ? {} : { url: body.url }),
          ...(body.events === undefined ? {} : { events: body.events }),
          ...(body.maxAttempts === undefined ? {} : { max_attempts: body.maxAttempts }),
          ...(body.active === undefined ? {} : { active: body.active }),
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .execute();
      // A deactivated endpoint drops what was still waiting: reactivating it must not replay a backlog.
      if (body.active === false && before.active) {
        await trx
          .updateTable("webhook_deliveries")
          .set({ status: "failed", last_error: "endpoint deactivated before delivery" })
          .where("endpoint_id", "=", id)
          .where("status", "=", "pending")
          .execute();
      }
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "webhook_endpoint.updated",
        objectType: "webhook_endpoint",
        objectId: id,
        before,
        after: body,
      });
    });
    const [endpoint] = await loadEndpoints(db, actor.centreId, id);
    return endpoint;
  });

  app.post("/webhooks/:id/rotate-secret", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const secret = newWebhookSecret();
    await db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable("webhook_endpoints")
        .set({ secret, updated_at: new Date() })
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .returning("id")
        .executeTakeFirst();
      if (!updated) throw notFound("webhook");
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "webhook_endpoint.secret_rotated",
        objectType: "webhook_endpoint",
        objectId: id,
      });
    });
    const [endpoint] = await loadEndpoints(db, actor.centreId, id);
    return { ...endpoint, secret };
  });

  app.delete("/webhooks/:id", { preHandler: manage }, async (request, reply) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    await db.transaction().execute(async (trx) => {
      const deleted = await trx
        .deleteFrom("webhook_endpoints")
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .returning(["name", "url", "events"])
        .executeTakeFirst();
      if (!deleted) throw notFound("webhook");
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "webhook_endpoint.deleted",
        objectType: "webhook_endpoint",
        objectId: id,
        before: deleted,
      });
    });
    return reply.status(204).send();
  });

  app.post("/webhooks/:id/test", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const endpoint = await db.selectFrom("webhook_endpoints").select("id").where("id", "=", id).where("centre_id", "=", actor.centreId).executeTakeFirst();
    if (!endpoint) throw notFound("webhook");
    return pingEndpoint(db, actor.centreId, id, config.webhooks.timeoutMs);
  });

  app.get("/webhooks/:id/deliveries", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const query = deliveriesQuery.parse(request.query);
    const endpoint = await db.selectFrom("webhook_endpoints").select("id").where("id", "=", id).where("centre_id", "=", actor.centreId).executeTakeFirst();
    if (!endpoint) throw notFound("webhook");
    let base = db.selectFrom("webhook_deliveries").where("endpoint_id", "=", id);
    if (query.status) base = base.where("status", "=", query.status);
    const rows = await base
      .select([
        "id",
        "event_type as eventType",
        "audit_id as auditId",
        "status",
        "attempts",
        "next_attempt_at as nextAttemptAt",
        "last_attempt_at as lastAttemptAt",
        "last_status_code as lastStatusCode",
        "last_error as lastError",
        "delivered_at as deliveredAt",
        "created_at as createdAt",
      ])
      .orderBy("created_at", "desc")
      .orderBy("id")
      .limit(query.pageSize + 1)
      .offset((query.page - 1) * query.pageSize)
      .execute();
    return { items: rows.slice(0, query.pageSize), hasMore: rows.length > query.pageSize, page: query.page };
  });

  app.post("/deliveries/:id/retry", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    return db.transaction().execute(async (trx) => {
      const delivery = await trx
        .selectFrom("webhook_deliveries as d")
        .innerJoin("webhook_endpoints as e", "e.id", "d.endpoint_id")
        .select(["d.status", "d.audit_id as auditId", "e.active"])
        .where("d.id", "=", id)
        .where("d.centre_id", "=", actor.centreId)
        .forUpdate("d")
        .executeTakeFirst();
      if (!delivery) throw notFound("delivery");
      if (delivery.status !== "failed") throw unprocessable("not_failed", "only a failed delivery can be sent again");
      if (delivery.auditId === null) throw unprocessable("ping_not_retried", "send a new test instead of retrying a test");
      if (!delivery.active) throw unprocessable("endpoint_inactive", "reactivate the webhook before sending again");
      await trx
        .updateTable("webhook_deliveries")
        .set({ status: "pending", attempts: 0, next_attempt_at: new Date(), last_error: null, last_status_code: null })
        .where("id", "=", id)
        .execute();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "webhook_delivery.retried",
        objectType: "webhook_delivery",
        objectId: id,
      });
      return { id, status: "pending" as const };
    });
  });
};
