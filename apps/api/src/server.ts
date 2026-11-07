import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { startWebhookDispatcher } from "./domain/webhooks.js";
import { startBackgroundJobs } from "./jobs.js";

const config = loadConfig();
const db = createDb(config.databaseUrl);
const app = await buildApp({ config, db });
const stopJobs = startBackgroundJobs(db, app.log);
const stopWebhooks = startWebhookDispatcher(db, app.log, config.webhooks);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  stopJobs();
  stopWebhooks();
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: config.port, host: config.host });
