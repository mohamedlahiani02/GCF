import { automationPeriod, localMoment } from "@gcf/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Kysely } from "kysely";
import type { AutomationKey, Database } from "../../db/types.js";
import type { Mailer } from "../../mail.js";
import { AUTOMATIONS, digestParams, parseParams, payrollParams, reminderParams } from "./definitions.js";
import { expireProposals } from "./proposals.js";
import { runDailyDigest, runOverdueReminders, runPayrollMonth, type RunContext } from "./runners.js";

const RUNNERS: Partial<Record<AutomationKey, (ctx: RunContext, params: Record<string, unknown>) => Promise<unknown>>> = {
  overdue_reminders: (ctx, params) => runOverdueReminders(ctx, reminderParams.parse(params)),
  payroll_month: (ctx, params) => runPayrollMonth(ctx, payrollParams.parse(params)),
  daily_digest: (ctx, params) => runDailyDigest(ctx, digestParams.parse(params)),
};

/**
 * Runs every scheduled automation whose period is due and has not run yet. A run is claimed by inserting its
 * (centre, automation, period) row, so with several servers exactly one runs it. A failure is recorded on the run
 * with its message and does not stop the other automations. Automations of a module the centre does not run are
 * skipped.
 */
export async function runDueAutomations(db: Kysely<Database>, mailer: Mailer | null, log: FastifyBaseLogger, now: Date = new Date()): Promise<number> {
  const settings = await db
    .selectFrom("automation_settings")
    .innerJoin("centres", "centres.id", "automation_settings.centre_id")
    .select([
      "automation_settings.centre_id as centreId",
      "automation_settings.key",
      "automation_settings.mode",
      "automation_settings.params",
      "centres.name",
      "centres.timezone",
      "centres.modules",
    ])
    .where("automation_settings.mode", "<>", "off")
    .execute();
  let runs = 0;
  for (const s of settings) {
    const definition = AUTOMATIONS[s.key];
    const runner = RUNNERS[s.key];
    if (!definition.schedule || !runner || s.mode === "off") continue;
    if (definition.module && !s.modules.includes(definition.module)) continue;
    let params: Record<string, unknown>;
    try {
      params = parseParams(s.key, s.params);
    } catch (error) {
      log.error({ err: error, centreId: s.centreId, key: s.key }, "automation parameters are no longer valid");
      continue;
    }
    const moment = localMoment(s.timezone, now);
    const { periodKey, due } = automationPeriod(definition.schedule(params), moment);
    if (!due) continue;
    const claimed = await db
      .insertInto("automation_runs")
      .values({ centre_id: s.centreId, key: s.key, period_key: periodKey, mode: s.mode })
      .onConflict((oc) => oc.columns(["centre_id", "key", "period_key"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!claimed) continue;
    runs += 1;
    const ctx: RunContext = {
      db,
      mailer,
      centre: { id: s.centreId, name: s.name, timezone: s.timezone, modules: s.modules },
      moment,
      now,
      mode: s.mode,
      runId: claimed.id,
    };
    try {
      await expireProposals(db, s.centreId);
      const summary = await runner(ctx, params);
      await db
        .updateTable("automation_runs")
        .set({ status: "done", finished_at: new Date(), summary: JSON.stringify(summary) })
        .where("id", "=", claimed.id)
        .execute();
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "unknown error";
      log.error({ err: error, centreId: s.centreId, key: s.key, periodKey }, "automation run failed");
      await db.updateTable("automation_runs").set({ status: "failed", finished_at: new Date(), error: message }).where("id", "=", claimed.id).execute();
    }
  }
  return runs;
}
