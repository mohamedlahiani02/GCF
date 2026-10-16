/**
 * Shows or sets the modules a centre subscribed to. Run by the software vendor, not from the back-office.
 * Usage: pnpm --filter @gcf/api modules                                   (list every centre and its modules)
 *        pnpm --filter @gcf/api modules -- --enable coworking [--centre <id>]
 *        pnpm --filter @gcf/api modules -- --disable website [--centre <id>]
 * Without --centre the database must hold exactly one centre.
 */
import { parseArgs } from "node:util";
import { writeAudit } from "../audit.js";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import type { Module } from "../db/types.js";
import { isModule, MODULES } from "../modules.js";

const { values } = parseArgs({
  options: { enable: { type: "string", multiple: true }, disable: { type: "string", multiple: true }, centre: { type: "string" } },
});
const enable = values.enable ?? [];
const disable = values.disable ?? [];
const unknown = [...enable, ...disable].filter((m) => !isModule(m));
if (unknown.length) {
  console.error(`unknown module(s): ${unknown.join(", ")}; known modules: ${MODULES.join(", ")}`);
  process.exit(2);
}

const db = createDb(loadConfig().databaseUrl);
try {
  const centres = await db.selectFrom("centres").select(["id", "name", "modules"]).orderBy("created_at").execute();
  if (!enable.length && !disable.length) {
    for (const c of centres) console.log(`${c.id}  ${c.name}: ${c.modules.join(", ") || "(none)"}`);
  } else {
    const target = values.centre ? centres.find((c) => c.id === values.centre) : centres.length === 1 ? centres[0] : undefined;
    if (!target) throw new Error(values.centre ? "no centre has this id" : "several centres exist: pass --centre <id>");
    const next = MODULES.filter((m) => (target.modules.includes(m) || enable.includes(m)) && !disable.includes(m)) as Module[];
    await db.transaction().execute(async (trx) => {
      await trx.updateTable("centres").set({ modules: next, updated_at: new Date() }).where("id", "=", target.id).execute();
      await writeAudit(trx, {
        centreId: target.id,
        userId: null,
        action: "centre.modules_changed",
        objectType: "centre",
        objectId: target.id,
        before: { modules: target.modules },
        after: { modules: next },
      });
    });
    console.log(`${target.name}: ${next.join(", ") || "(none)"}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
