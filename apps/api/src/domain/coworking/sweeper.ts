import { sql, type Kysely, type Transaction } from "kysely";
import { writeAudit } from "../../audit.js";
import type { Database } from "../../db/types.js";
import { deactivateRoomBooking } from "./bookings.js";
import { releaseUsage } from "./entitlements.js";

interface Changed {
  id: string;
  centre_id: string;
}

async function auditSweep(trx: Transaction<Database>, rows: Changed[], status: string): Promise<void> {
  for (const row of rows) {
    await writeAudit(trx, {
      centreId: row.centre_id,
      userId: null,
      action: `cw_booking.${status}`,
      objectType: "cw_booking",
      objectId: row.id,
      after: { status },
    });
  }
}

/**
 * Time-driven booking changes (rule 13). Requests expire after request_expiry_hours or at their start and give
 * back their quotas; confirmed bookings without check-in become no-shows after no_show_grace_minutes (when set)
 * and keep their charge; confirmed or checked-in bookings whose end has passed are completed. Each step is a
 * conditional update in its own transaction, so a row already changed by another process is skipped.
 * Returns how many rows changed.
 */
export async function sweepCoworking(db: Kysely<Database>, now: Date = new Date()): Promise<number> {
  await sql`insert into cw_settings (centre_id) select id from centres where 'coworking' = any(modules) on conflict (centre_id) do nothing`.execute(db);

  const expired = await db.transaction().execute(async (trx) => {
    const rows = await sql<Changed>`
      update cw_bookings b set status = 'expired', updated_at = ${now}
      from cw_settings s
      where s.centre_id = b.centre_id and b.status = 'requested'
        and (b.requested_at + make_interval(hours => s.request_expiry_hours) <= ${now} or b.starts_at <= ${now})
      returning b.id, b.centre_id`.execute(trx);
    const ids = rows.rows.map((r) => r.id);
    await releaseUsage(trx, ids);
    await deactivateRoomBooking(trx, ids);
    await auditSweep(trx, rows.rows, "expired");
    return ids.length;
  });

  const noShows = await db.transaction().execute(async (trx) => {
    const rows = await sql<Changed>`
      update cw_bookings b set status = 'no_show', updated_at = ${now}
      from cw_settings s
      where s.centre_id = b.centre_id and b.kind = 'booking' and b.status = 'confirmed' and b.checked_in_at is null
        and s.no_show_grace_minutes is not null and b.starts_at + make_interval(mins => s.no_show_grace_minutes) <= ${now}
      returning b.id, b.centre_id`.execute(trx);
    await deactivateRoomBooking(
      trx,
      rows.rows.map((r) => r.id),
    );
    await auditSweep(trx, rows.rows, "no_show");
    return rows.rows.length;
  });

  const completed = await db.transaction().execute(async (trx) => {
    const rows = await sql<Changed>`
      update cw_bookings set status = 'completed', updated_at = ${now}
      where status in ('confirmed', 'checked_in') and ends_at <= ${now}
      returning id, centre_id`.execute(trx);
    await auditSweep(trx, rows.rows, "completed");
    return rows.rows.length;
  });

  return expired + noShows + completed;
}
