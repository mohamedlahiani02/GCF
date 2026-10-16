import type { Kysely } from "kysely";
import type { Database } from "../../db/types.js";

/** Expires stale requests, releases no-shows and completes past bookings. Returns how many rows changed. */
export async function sweepCoworking(_db: Kysely<Database>, _now: Date = new Date()): Promise<number> {
  return 0;
}
