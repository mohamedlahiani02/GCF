import { automationPeriod, localMoment } from "@gcf/shared";
import { sql, type Kysely, type Transaction } from "kysely";
import type { AutomationKey, AutomationMode, Database } from "../../db/types.js";
import { AUTOMATION_KEYS, AUTOMATIONS, parseParams } from "./definitions.js";

type Db = Kysely<Database> | Transaction<Database>;

export interface AutomationSetting {
  key: AutomationKey;
  mode: AutomationMode;
  params: Record<string, unknown>;
  updatedAt: Date | null;
  updatedByName: string | null;
}

/** Every automation of the centre, with its saved mode and parameters or the defaults (off). */
export async function loadSettings(db: Db, centreId: string): Promise<AutomationSetting[]> {
  const rows = await db
    .selectFrom("automation_settings")
    .leftJoin("users", "users.id", "automation_settings.updated_by")
    .select(["automation_settings.key", "automation_settings.mode", "automation_settings.params", "automation_settings.updated_at", "users.full_name"])
    .where("automation_settings.centre_id", "=", centreId)
    .execute();
  return AUTOMATION_KEYS.map((key) => {
    const row = rows.find((r) => r.key === key);
    return {
      key,
      mode: row?.mode ?? "off",
      params: parseParams(key, row?.params),
      updatedAt: row?.updated_at ?? null,
      updatedByName: row?.full_name ?? null,
    };
  });
}

export async function automationMode(db: Db, centreId: string, key: AutomationKey): Promise<AutomationMode> {
  const row = await db.selectFrom("automation_settings").select("mode").where("centre_id", "=", centreId).where("key", "=", key).executeTakeFirst();
  return row?.mode ?? "off";
}

/**
 * Saves a setting. When a scheduled automation is switched on after its hour in the current period, that period is
 * marked as skipped: switching on never fires a run at once, which the person would not expect.
 */
export async function saveSetting(
  trx: Transaction<Database>,
  centreId: string,
  userId: string,
  key: AutomationKey,
  mode: AutomationMode,
  params: Record<string, unknown>,
  now: Date = new Date(),
): Promise<{ before: { mode: AutomationMode; params: Record<string, unknown> } }> {
  const previous = await trx
    .selectFrom("automation_settings")
    .select(["mode", "params"])
    .where("centre_id", "=", centreId)
    .where("key", "=", key)
    .forUpdate()
    .executeTakeFirst();
  await trx
    .insertInto("automation_settings")
    .values({ centre_id: centreId, key, mode, params: JSON.stringify(params), updated_by: userId, updated_at: now })
    .onConflict((oc) => oc.columns(["centre_id", "key"]).doUpdateSet({ mode, params: JSON.stringify(params), updated_by: userId, updated_at: now }))
    .execute();
  const schedule = AUTOMATIONS[key].schedule;
  if (schedule && mode !== "off" && (previous?.mode ?? "off") === "off") {
    const centre = await trx.selectFrom("centres").select("timezone").where("id", "=", centreId).executeTakeFirstOrThrow();
    // Only a period whose hour has already passed is skipped: switched on at 09:00 for an 18:00 digest, today's
    // digest still goes out.
    const { periodKey, due } = automationPeriod(schedule(params), localMoment(centre.timezone, now));
    if (due)
      await trx
        .insertInto("automation_runs")
        .values({
          centre_id: centreId,
          key,
          period_key: periodKey,
          mode,
          status: "skipped",
          finished_at: now,
          summary: JSON.stringify({ reason: "switched_on" }),
        })
        .onConflict((oc) => oc.columns(["centre_id", "key", "period_key"]).doNothing())
        .execute();
  }
  return { before: { mode: previous?.mode ?? "off", params: parseParams(key, previous?.params) } };
}

export async function recentRuns(db: Db, centreId: string, limit = 5) {
  return db
    .selectFrom("automation_runs")
    .select(["id", "key", "period_key as periodKey", "mode", "status", "started_at as startedAt", "finished_at as finishedAt", "summary", "error"])
    .where("centre_id", "=", centreId)
    .where(
      sql<boolean>`(select count(*) from automation_runs newer where newer.centre_id = automation_runs.centre_id and newer.key = automation_runs.key and newer.started_at > automation_runs.started_at) < ${limit}`,
    )
    .orderBy("started_at", "desc")
    .execute();
}
