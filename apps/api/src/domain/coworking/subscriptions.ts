import type { Kysely } from "kysely";
import type { Database } from "../../db/types.js";

/** Creates the next period of subscriptions marked for automatic renewal that end today or earlier. */
export async function autoRenewSubscriptions(_db: Kysely<Database>, _now: Date = new Date()): Promise<number> {
  return 0;
}
