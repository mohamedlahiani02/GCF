import { createHmac, randomBytes } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { sql, type Kysely } from "kysely";
import type { Database } from "../db/types.js";

export const SIGNATURE_HEADER = "x-gcf-signature";
export const TIMESTAMP_HEADER = "x-gcf-timestamp";
export const EVENT_HEADER = "x-gcf-event";
export const DELIVERY_HEADER = "x-gcf-delivery";

/** Deliveries claimed per run, and how long a claim holds before another process may take the delivery over. */
const BATCH_SIZE = 20;
const CLAIM_MINUTES = 10;
/** Retry delays double from one minute and stop growing at six hours. */
const FIRST_RETRY_SECONDS = 60;
const MAX_RETRY_SECONDS = 6 * 3600;
const ERROR_MAX_LENGTH = 500;

/** Event patterns accepted on an endpoint: an exact action, a family ("payment.*") or everything ("*"). */
export const EVENT_PATTERN = /^(\*|[a-z][a-z0-9_]*\.\*|[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)$/;

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

/**
 * The signature of a delivery: hex HMAC-SHA256 of "<timestamp>.<raw body>" with the endpoint secret. The
 * receiver recomputes it and rejects a timestamp too far from its own clock, which defeats replays.
 */
export function signDelivery(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/**
 * What a receiver gets. Only identifiers: the details, which may be personal data, are read back through the API
 * with an access token, under that token's role.
 */
export interface WebhookPayload {
  id: string;
  type: string;
  occurredAt: string;
  centreId: string;
  object: { type: string; id: string } | null;
}

/** Delay before the next attempt once `attempts` attempts have failed. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(FIRST_RETRY_SECONDS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_SECONDS);
}

interface ClaimedDelivery {
  id: string;
  centre_id: string;
  event_type: string;
  attempts: number;
  audit_id: number | null;
  url: string;
  secret: string;
  max_attempts: number;
  at: Date | null;
  object_type: string | null;
  object_id: string | null;
}

export interface AttemptResult {
  status: "delivered" | "pending" | "failed";
  statusCode: number | null;
  error: string | null;
}

function payloadOf(d: ClaimedDelivery, now: Date): WebhookPayload {
  if (d.audit_id === null) {
    return { id: `evt_ping_${d.id}`, type: "ping", occurredAt: now.toISOString(), centreId: d.centre_id, object: null };
  }
  return {
    id: `evt_${d.audit_id}`,
    type: d.event_type,
    occurredAt: new Date(d.at!).toISOString(),
    centreId: d.centre_id,
    object: { type: d.object_type!, id: d.object_id! },
  };
}

async function send(d: ClaimedDelivery, timeoutMs: number): Promise<{ ok: boolean; statusCode: number | null; error: string | null }> {
  const now = new Date();
  const body = JSON.stringify(payloadOf(d, now));
  const timestamp = String(Math.floor(now.getTime() / 1000));
  try {
    const response = await fetch(d.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "content-type": "application/json",
        "user-agent": "GCF-Webhooks/1",
        [EVENT_HEADER]: d.event_type,
        [DELIVERY_HEADER]: d.id,
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: signDelivery(d.secret, timestamp, body),
      },
      body,
    });
    await response.body?.cancel();
    if (response.status >= 200 && response.status < 300) return { ok: true, statusCode: response.status, error: null };
    return { ok: false, statusCode: response.status, error: `receiver answered HTTP ${response.status}` };
  } catch (error) {
    const reason = error instanceof Error ? (error.name === "TimeoutError" ? `no answer within ${timeoutMs} ms` : error.message) : "unknown error";
    return { ok: false, statusCode: null, error: reason.slice(0, ERROR_MAX_LENGTH) };
  }
}

/** Sends one claimed delivery and records the outcome. A ping is tried once and never retried. */
async function attempt(db: Kysely<Database>, d: ClaimedDelivery, timeoutMs: number): Promise<AttemptResult> {
  const result = await send(d, timeoutMs);
  const attempts = d.attempts + 1;
  const status: AttemptResult["status"] = result.ok ? "delivered" : d.audit_id === null || attempts >= d.max_attempts ? "failed" : "pending";
  await db
    .updateTable("webhook_deliveries")
    .set({
      status,
      attempts,
      last_attempt_at: new Date(),
      last_status_code: result.statusCode,
      last_error: result.error,
      delivered_at: result.ok ? new Date() : null,
      next_attempt_at: sql<Date>`now() + make_interval(secs => ${status === "pending" ? retryDelaySeconds(attempts) : 0})`,
    })
    .where("id", "=", d.id)
    .execute();
  return { status, statusCode: result.statusCode, error: result.error };
}

const claimedColumns = sql`
  d.id, d.centre_id, d.event_type, d.attempts, d.audit_id, e.url, e.secret, e.max_attempts,
  a.at, a.object_type, a.object_id`;

/**
 * Claims the deliveries that are due and sends them. The claim pushes next_attempt_at forward in the same
 * statement that selects the rows (skipping rows locked by another process), so several servers can run this at
 * once without sending a delivery twice; a claim left by a crashed process expires after CLAIM_MINUTES.
 */
export async function dispatchDueDeliveries(db: Kysely<Database>, timeoutMs: number): Promise<{ delivered: number; retried: number; failed: number }> {
  const claimed = await sql<ClaimedDelivery>`
    with due as (
      select d.id from webhook_deliveries d
      join webhook_endpoints e on e.id = d.endpoint_id
      where d.status = 'pending' and d.next_attempt_at <= now() and e.active
      order by d.next_attempt_at, d.audit_id
      limit ${BATCH_SIZE}
      for update of d skip locked
    ), claimed as (
      update webhook_deliveries d set next_attempt_at = now() + make_interval(mins => ${CLAIM_MINUTES})
      from due where d.id = due.id
      returning d.*
    )
    select ${claimedColumns}
    from claimed d
    join webhook_endpoints e on e.id = d.endpoint_id
    left join audit_log a on a.id = d.audit_id
    order by d.audit_id`.execute(db);
  const counts = { delivered: 0, retried: 0, failed: 0 };
  for (const d of claimed.rows) {
    const result = await attempt(db, d, timeoutMs);
    if (result.status === "delivered") counts.delivered += 1;
    else if (result.status === "pending") counts.retried += 1;
    else counts.failed += 1;
  }
  return counts;
}

/** Sends a ping to an endpoint now, whether it is active or not, and records it in its delivery log. */
export async function pingEndpoint(
  db: Kysely<Database>,
  centreId: string,
  endpointId: string,
  timeoutMs: number,
): Promise<AttemptResult & { deliveryId: string }> {
  const created = await db
    .insertInto("webhook_deliveries")
    .values({ centre_id: centreId, endpoint_id: endpointId, audit_id: null, event_type: "ping", next_attempt_at: sql<Date>`now() + interval '1 hour'` })
    .returning("id")
    .executeTakeFirstOrThrow();
  const row = await sql<ClaimedDelivery>`
    select ${claimedColumns}
    from webhook_deliveries d
    join webhook_endpoints e on e.id = d.endpoint_id
    left join audit_log a on a.id = d.audit_id
    where d.id = ${created.id}`.execute(db);
  const result = await attempt(db, row.rows[0]!, timeoutMs);
  return { ...result, deliveryId: created.id };
}

/** Deletes finished deliveries older than the retention period. Pending ones are always kept. */
export async function purgeOldDeliveries(db: Kysely<Database>, retentionDays: number): Promise<number> {
  const result = await db
    .deleteFrom("webhook_deliveries")
    .where("status", "<>", "pending")
    .where("created_at", "<", sql<Date>`now() - make_interval(days => ${retentionDays})`)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

/** Runs the dispatcher on its own timer; returns the function that stops it. */
export function startWebhookDispatcher(
  db: Kysely<Database>,
  log: FastifyBaseLogger,
  options: { dispatchSeconds: number; timeoutMs: number; retentionDays: number },
): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const counts = await dispatchDueDeliveries(db, options.timeoutMs);
      const purged = await purgeOldDeliveries(db, options.retentionDays);
      if (counts.delivered || counts.retried || counts.failed || purged) log.info({ ...counts, purged }, "webhook deliveries processed");
    } catch (error) {
      log.error({ err: error }, "webhook dispatch failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), options.dispatchSeconds * 1000);
  void run();
  return () => clearInterval(timer);
}
