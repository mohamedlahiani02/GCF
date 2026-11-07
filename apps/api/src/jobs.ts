import type { FastifyBaseLogger } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "./db/types.js";
import { sweepCoworking } from "./domain/coworking/sweeper.js";
import { autoRenewSubscriptions } from "./domain/coworking/subscriptions.js";
import { runDueAutomations } from "./domain/automations/scheduler.js";
import type { Mailer } from "./mail.js";
import { promoteScheduledPages } from "./site/scheduling.js";

const EVERY_MS = 60_000;

/**
 * Time-driven changes: expired booking requests, no-shows, finished bookings, automatic subscription renewals,
 * scheduled page publication and the centre's scheduled automations.
 * Each run is idempotent, so several server processes may run it at the same time.
 */
export function startBackgroundJobs(db: Kysely<Database>, log: FastifyBaseLogger, mailer: Mailer | null): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const bookings = await sweepCoworking(db);
      const renewals = await autoRenewSubscriptions(db);
      const pages = await promoteScheduledPages(db);
      const automations = await runDueAutomations(db, mailer, log);
      if (bookings || renewals || pages || automations) log.info({ bookings, renewals, pages, automations }, "background jobs applied changes");
    } catch (error) {
      log.error({ err: error }, "background jobs failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), EVERY_MS);
  void run();
  return () => clearInterval(timer);
}
