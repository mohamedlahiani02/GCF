import { sql, type Kysely } from "kysely";
import { writeAudit } from "../audit.js";
import type { Database } from "../db/types.js";

/**
 * Publishes the page versions whose scheduled time has come. The update is conditional on the schedule still
 * being there, so concurrent runs (several processes) publish each version once. Returns how many pages changed.
 */
export async function promoteScheduledPages(db: Kysely<Database>, now: Date = new Date()): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const promoted = await trx
      .updateTable("site_pages")
      .set({
        published_version_id: sql<string>`scheduled_version_id`,
        status: "published",
        scheduled_version_id: null,
        scheduled_at: null,
        updated_at: now,
      })
      .where("scheduled_at", "<=", now)
      .where("scheduled_version_id", "is not", null)
      .where("status", "<>", "archived")
      .returning(["id", "centre_id", "published_version_id"])
      .execute();
    for (const page of promoted) {
      await writeAudit(trx, {
        centreId: page.centre_id,
        userId: null,
        action: "site_page.published",
        objectType: "site_page",
        objectId: page.id,
        after: { versionId: page.published_version_id, scheduled: true },
      });
    }
    return promoted.length;
  });
}
