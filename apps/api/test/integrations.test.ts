import { createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dispatchDueDeliveries, purgeOldDeliveries, retryDelaySeconds } from "../src/domain/webhooks.js";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
let admin: string;
let secretariat: string;
let adminId: string;

/** A local receiver standing in for n8n: records each request and answers with the status it is told to. */
interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}
let receiver: Server;
let receiverUrl: string;
const received: Received[] = [];
let answer = 200;

const TIMEOUT_MS = 2_000;

async function bearer(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, token: string, payload?: unknown, extra: Record<string, string> = {}) {
  const response = await h.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, ...extra },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: response.statusCode, body: response.body ? response.json() : undefined };
}

const newToken = async (body: Record<string, unknown>) => {
  const created = await h.call("POST", "/api/integrations/tokens", admin, body);
  expect(created.status).toBe(201);
  return created.body as { id: string; token: string; prefix: string; state: string };
};

const createStudent = (token: string, firstName: string) => bearer("POST", "/api/students", token, { firstName, lastName: "Intégration" });

beforeAll(async () => {
  h = await createHarness();
  adminId = await h.createUser("admin", "admin@integrations.tn");
  await h.createUser("admin", "admin2@integrations.tn");
  await h.createUser("secretariat", "sec@integrations.tn");
  admin = await h.login("admin@integrations.tn");
  secretariat = await h.login("sec@integrations.tn");
  receiver = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      received.push({ headers: request.headers, body });
      response.statusCode = answer;
      response.end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  await h.close();
});

beforeEach(() => {
  received.length = 0;
  answer = 200;
});

describe("access tokens", () => {
  it("are managed by an administrator only and shown in clear once", async () => {
    expect((await h.call("GET", "/api/integrations/tokens", secretariat)).status).toBe(403);
    const created = await newToken({ name: "n8n lecture", role: "secretariat" });
    expect(created.token).toMatch(/^gcf_[A-Za-z0-9_-]{43}$/);
    expect(created.token.startsWith(created.prefix)).toBe(true);
    expect(created).toMatchObject({ state: "active", readOnly: true });
    const list = await h.call("GET", "/api/integrations/tokens", admin);
    const listed = list.body.find((t: { id: string }) => t.id === created.id);
    expect(listed).toMatchObject({ name: "n8n lecture", role: "secretariat", readOnly: true, createdByName: "admin user" });
    expect(JSON.stringify(list.body)).not.toContain(created.token);
    const stored = await h.db.selectFrom("api_tokens").select("token_hash").where("id", "=", created.id).executeTakeFirstOrThrow();
    expect(stored.token_hash.toString("utf8")).not.toContain(created.token);
  });

  it("refuses an admin role, an unknown role and an expiry in the past", async () => {
    expect((await h.call("POST", "/api/integrations/tokens", admin, { name: "x", role: "admin" })).status).toBe(400);
    expect((await h.call("POST", "/api/integrations/tokens", admin, { name: "x", role: "owner" })).status).toBe(400);
    const past = await h.call("POST", "/api/integrations/tokens", admin, { name: "x", role: "secretariat", expiresAt: "2020-01-01T00:00:00Z" });
    expect(past.status).toBe(422);
  });

  it("give the role of the token, not of the administrator who created it", async () => {
    const { token } = await newToken({ name: "Secrétariat", role: "secretariat" });
    expect((await bearer("GET", "/api/students", token)).status).toBe(200);
    expect((await bearer("GET", "/api/payroll/rules", token)).status).toBe(403);
    const session = await bearer("GET", "/api/auth/session", token);
    expect(session.status).toBe(200);
    expect(session.body.user.role).toBe("secretariat");
    expect(session.body.permissions).not.toContain("payroll:read");
  });

  it("only read when they are read-only", async () => {
    const { token } = await newToken({ name: "Lecture", role: "secretariat", readOnly: true });
    const refused = await createStudent(token, "Refusé");
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("read_only_token");
  });

  it("write without an Origin header and are named in the audit log", async () => {
    const { id, token } = await newToken({ name: "n8n écriture", role: "secretariat", readOnly: false });
    const created = await createStudent(token, "Jeton");
    expect(created.status).toBe(201);
    const row = await h.db
      .selectFrom("audit_log")
      .select(["user_id", "api_token_id"])
      .where("action", "=", "student.created")
      .where("object_id", "=", created.body.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ user_id: adminId, api_token_id: id });
    const log = await h.call("GET", `/api/audit-log?objectType=student&objectId=${created.body.id}`, admin);
    expect(log.body.items[0]).toMatchObject({ userName: "admin user", apiTokenName: "n8n écriture" });
    // The same change made in the back-office is not attributed to any token.
    const direct = await h.call("POST", "/api/students", secretariat, { firstName: "Direct", lastName: "Intégration" });
    const directRow = await h.db.selectFrom("audit_log").select("api_token_id").where("object_id", "=", direct.body.id).executeTakeFirstOrThrow();
    expect(directRow.api_token_id).toBeNull();
  });

  it("cannot reach sign-in, user accounts or the integration settings", async () => {
    const { token } = await newToken({ name: "Fermé", role: "accountant", readOnly: false });
    for (const [method, url] of [
      ["GET", "/api/integrations/tokens"],
      ["POST", "/api/integrations/tokens"],
      ["GET", "/api/users"],
      ["POST", "/api/auth/password"],
      ["POST", "/api/auth/logout"],
    ] as const) {
      const response = await bearer(method, url, token, method === "POST" ? {} : undefined);
      expect(response.status, `${method} ${url}`).toBe(403);
      expect(response.body.code).toBe("token_not_allowed");
    }
  });

  it("are refused when unknown, malformed, sent with a cookie, revoked, expired or orphaned", async () => {
    expect((await bearer("GET", "/api/students", "gcf_unknownunknownunknownunknownunknown")).status).toBe(401);
    const malformed = await h.app.inject({ method: "GET", url: "/api/students", headers: { authorization: "Basic dXNlcjpwYXNz" } });
    expect(malformed.statusCode).toBe(401);

    const { id, token } = await newToken({ name: "Cycle de vie", role: "secretariat" });
    const both = await h.app.inject({ method: "GET", url: "/api/students", headers: { authorization: `Bearer ${token}`, cookie: secretariat } });
    expect(both.statusCode).toBe(400);

    const revoked = await h.call("POST", `/api/integrations/tokens/${id}/revoke`, admin);
    expect(revoked.body.state).toBe("revoked");
    expect((await bearer("GET", "/api/students", token)).status).toBe(401);
    expect((await h.call("POST", `/api/integrations/tokens/${id}/revoke`, admin)).status).toBe(422);

    const expiring = await newToken({ name: "Expire", role: "secretariat", expiresAt: "2026-12-31T00:00:00Z" });
    expect((await bearer("GET", "/api/students", expiring.token)).status).toBe(200);
    await h.db
      .updateTable("api_tokens")
      .set({ created_at: sql<Date>`now() - interval '2 days'`, expires_at: sql<Date>`now() - interval '1 day'` })
      .where("id", "=", expiring.id)
      .execute();
    expect((await bearer("GET", "/api/students", expiring.token)).status).toBe(401);

    const orphan = await newToken({ name: "Orphelin", role: "secretariat" });
    await h.db.updateTable("users").set({ role: "secretariat" }).where("id", "=", adminId).execute();
    expect((await bearer("GET", "/api/students", orphan.token)).status).toBe(401);
    await h.db.updateTable("users").set({ role: "admin" }).where("id", "=", adminId).execute();
    expect((await bearer("GET", "/api/students", orphan.token)).status).toBe(200);
  });
});

describe("webhooks", () => {
  let writer: string;

  beforeAll(async () => {
    writer = (await newToken({ name: "Webhooks", role: "secretariat", readOnly: false })).token;
  });

  const createEndpoint = async (body: Record<string, unknown>) => {
    const created = await h.call("POST", "/api/integrations/webhooks", admin, { name: "n8n", url: receiverUrl, ...body });
    expect(created.status).toBe(201);
    return created.body as { id: string; secret: string };
  };
  const deliveries = (endpointId: string) =>
    h.db.selectFrom("webhook_deliveries").selectAll().where("endpoint_id", "=", endpointId).orderBy("created_at").orderBy("audit_id").execute();
  const makeDue = (endpointId: string) =>
    h.db
      .updateTable("webhook_deliveries")
      .set({ next_attempt_at: sql<Date>`now() - interval '1 second'` })
      .where("endpoint_id", "=", endpointId)
      .where("status", "=", "pending")
      .execute();
  const deactivate = (id: string) => h.call("PATCH", `/api/integrations/webhooks/${id}`, admin, { active: false });

  it("validates the address and the event patterns", async () => {
    const bad = (body: Record<string, unknown>) => h.call("POST", "/api/integrations/webhooks", admin, { name: "x", url: receiverUrl, events: ["*"], ...body });
    expect((await bad({ url: "ftp://example.tn/hook" })).status).toBe(400);
    expect((await bad({ events: ["Payment Created"] })).status).toBe(400);
    expect((await bad({ events: ["payment.*", "payment.*"] })).status).toBe(400);
    expect((await bad({ events: [] })).status).toBe(400);
    expect((await h.call("POST", "/api/integrations/webhooks", secretariat, { name: "x", url: receiverUrl, events: ["*"] })).status).toBe(403);
  });

  it("queues matching changes with the change itself and sends them signed, with identifiers only", async () => {
    const endpoint = await createEndpoint({ events: ["student.*"] });
    expect(endpoint.secret).toMatch(/^whsec_/);
    const student = await createStudent(writer, "Signé");
    await bearer("POST", "/api/catalogue/subjects", writer, { name: "Chimie" });
    const queued = await deliveries(endpoint.id);
    expect(queued.map((d) => [d.event_type, d.status])).toEqual([["student.created", "pending"]]);

    expect(await dispatchDueDeliveries(h.db, TIMEOUT_MS)).toEqual({ delivered: 1, retried: 0, failed: 0 });
    expect(received).toHaveLength(1);
    const { headers, body } = received[0]!;
    const timestamp = String(headers["x-gcf-timestamp"]);
    const expected = `sha256=${createHmac("sha256", endpoint.secret).update(`${timestamp}.${body}`).digest("hex")}`;
    expect(headers["x-gcf-signature"]).toBe(expected);
    expect(headers["x-gcf-event"]).toBe("student.created");
    expect(headers["x-gcf-delivery"]).toBe(queued[0]!.id);
    expect(Math.abs(Number(timestamp) * 1000 - Date.now())).toBeLessThan(5_000);
    const payload = JSON.parse(body);
    expect(payload).toEqual({
      id: `evt_${queued[0]!.audit_id}`,
      type: "student.created",
      occurredAt: expect.any(String),
      centreId: h.centreId,
      object: { type: "student", id: student.body.id },
    });
    expect(body).not.toContain("Signé");
    // The receiver can re-serialise the parsed body and still check the signature.
    expect(JSON.stringify(JSON.parse(body))).toBe(body);
    const [done] = await deliveries(endpoint.id);
    expect(done).toMatchObject({ status: "delivered", attempts: 1, last_status_code: 200 });
    // Nothing is sent twice.
    expect(await dispatchDueDeliveries(h.db, TIMEOUT_MS)).toEqual({ delivered: 0, retried: 0, failed: 0 });
    await deactivate(endpoint.id);
  });

  it("retries with a growing delay, gives up after the maximum, and can be sent again by hand", async () => {
    expect([1, 2, 3, 10, 30].map(retryDelaySeconds)).toEqual([60, 120, 240, 21_600, 21_600]);
    const endpoint = await createEndpoint({ events: ["student.created"], maxAttempts: 2 });
    await createStudent(writer, "Relance");
    answer = 503;
    expect(await dispatchDueDeliveries(h.db, TIMEOUT_MS)).toEqual({ delivered: 0, retried: 1, failed: 0 });
    let [delivery] = await deliveries(endpoint.id);
    expect(delivery).toMatchObject({ status: "pending", attempts: 1, last_status_code: 503, last_error: "receiver answered HTTP 503" });
    const wait = new Date(delivery!.next_attempt_at).getTime() - Date.now();
    expect(wait).toBeGreaterThan(55_000);
    expect(wait).toBeLessThan(65_000);
    // Not due yet: nothing is sent.
    expect(await dispatchDueDeliveries(h.db, TIMEOUT_MS)).toEqual({ delivered: 0, retried: 0, failed: 0 });
    await makeDue(endpoint.id);
    expect(await dispatchDueDeliveries(h.db, TIMEOUT_MS)).toEqual({ delivered: 0, retried: 0, failed: 1 });
    [delivery] = await deliveries(endpoint.id);
    expect(delivery).toMatchObject({ status: "failed", attempts: 2 });

    const failedList = await h.call("GET", `/api/integrations/webhooks/${endpoint.id}/deliveries?status=failed`, admin);
    expect(failedList.body.items).toHaveLength(1);
    answer = 200;
    const retried = await h.call("POST", `/api/integrations/deliveries/${delivery!.id}/retry`, admin);
    expect(retried.body).toEqual({ id: delivery!.id, status: "pending" });
    expect(await dispatchDueDeliveries(h.db, TIMEOUT_MS)).toEqual({ delivered: 1, retried: 0, failed: 0 });
    expect((await h.call("POST", `/api/integrations/deliveries/${delivery!.id}/retry`, admin)).status).toBe(422);
    await deactivate(endpoint.id);
  });

  it("counts an unreachable receiver as a failed attempt", async () => {
    const endpoint = await createEndpoint({ url: "http://127.0.0.1:9/closed", events: ["student.created"], maxAttempts: 1 });
    await createStudent(writer, "Injoignable");
    expect(await dispatchDueDeliveries(h.db, TIMEOUT_MS)).toEqual({ delivered: 0, retried: 0, failed: 1 });
    const [delivery] = await deliveries(endpoint.id);
    expect(delivery!.last_status_code).toBeNull();
    expect(delivery!.last_error).toBeTruthy();
    await deactivate(endpoint.id);
  });

  it("drops what is waiting when the webhook is deactivated, and stops queueing", async () => {
    const endpoint = await createEndpoint({ events: ["*"] });
    await createStudent(writer, "Désactivé");
    expect((await deliveries(endpoint.id)).some((d) => d.status === "pending")).toBe(true);
    const updated = await deactivate(endpoint.id);
    expect(updated.body).toMatchObject({ active: false, pending: 0 });
    const after = await deliveries(endpoint.id);
    expect(after.every((d) => d.status === "failed" && d.last_error === "endpoint deactivated before delivery")).toBe(true);
    const count = after.length;
    await createStudent(writer, "Ignoré");
    expect(await deliveries(endpoint.id)).toHaveLength(count);
    expect(received).toHaveLength(0);
  });

  it("sends a test ping on demand and keeps it in the log", async () => {
    const endpoint = await createEndpoint({ events: ["payment.*"] });
    const ping = await h.call("POST", `/api/integrations/webhooks/${endpoint.id}/test`, admin);
    expect(ping.body).toMatchObject({ status: "delivered", statusCode: 200, error: null });
    expect(JSON.parse(received[0]!.body)).toMatchObject({ type: "ping", object: null, centreId: h.centreId });
    answer = 500;
    const failed = await h.call("POST", `/api/integrations/webhooks/${endpoint.id}/test`, admin);
    expect(failed.body).toMatchObject({ status: "failed", statusCode: 500 });
    const log = await h.call("GET", `/api/integrations/webhooks/${endpoint.id}/deliveries`, admin);
    expect(log.body.items.map((d: { eventType: string; status: string }) => [d.eventType, d.status])).toEqual([
      ["ping", "failed"],
      ["ping", "delivered"],
    ]);
    expect((await h.call("POST", `/api/integrations/deliveries/${log.body.items[0].id}/retry`, admin)).status).toBe(422);
    await deactivate(endpoint.id);
  });

  it("never sends a delivery twice when two servers dispatch at the same time", async () => {
    const endpoint = await createEndpoint({ events: ["student.created"] });
    for (const name of ["Un", "Deux", "Trois"]) await createStudent(writer, name);
    const [a, b] = await Promise.all([dispatchDueDeliveries(h.db, TIMEOUT_MS), dispatchDueDeliveries(h.db, TIMEOUT_MS)]);
    expect(a.delivered + b.delivered).toBe(3);
    expect(received).toHaveLength(3);
    expect(new Set(received.map((r) => r.headers["x-gcf-delivery"])).size).toBe(3);
    await deactivate(endpoint.id);
  });

  it("rotates the secret, deletes an endpoint, suggests events and purges old deliveries", async () => {
    const endpoint = await createEndpoint({ events: ["student.created"] });
    const rotated = await h.call("POST", `/api/integrations/webhooks/${endpoint.id}/rotate-secret`, admin);
    expect(rotated.body.secret).toMatch(/^whsec_/);
    expect(rotated.body.secret).not.toBe(endpoint.secret);
    const listed = await h.call("GET", "/api/integrations/webhooks", admin);
    expect(JSON.stringify(listed.body)).not.toContain("whsec_");
    const audit = await h.db.selectFrom("audit_log").select(["after"]).where("object_type", "=", "webhook_endpoint").execute();
    expect(JSON.stringify(audit)).not.toContain("whsec_");

    const suggestions = await h.call("GET", "/api/integrations/events", admin);
    expect(suggestions.body.actions).toEqual(expect.arrayContaining(["student.created", "webhook_endpoint.created"]));

    await createStudent(writer, "Purge");
    await dispatchDueDeliveries(h.db, TIMEOUT_MS);
    await h.db
      .updateTable("webhook_deliveries")
      .set({ created_at: sql<Date>`now() - interval '31 days'` })
      .where("endpoint_id", "=", endpoint.id)
      .execute();
    expect(await purgeOldDeliveries(h.db, 30)).toBeGreaterThanOrEqual(1);
    expect(await deliveries(endpoint.id)).toHaveLength(0);

    expect((await h.call("DELETE", `/api/integrations/webhooks/${endpoint.id}`, admin)).status).toBe(204);
    expect((await h.call("GET", `/api/integrations/webhooks/${endpoint.id}/deliveries`, admin)).status).toBe(404);
  });
});
