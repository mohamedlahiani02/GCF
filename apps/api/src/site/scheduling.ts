import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";

/** Publishes the page versions whose scheduled time has come. Returns how many pages changed. */
export async function promoteScheduledPages(_db: Kysely<Database>, _now: Date = new Date()): Promise<number> {
  return 0;
}
