import { sql, type Kysely } from "kysely";
import type { Database } from "../../db/types.js";
import { loadBooking, notifyMember, type MailContext } from "./bookings.js";

/**
 * E-mails a reminder before each confirmed booking, reminder_hours ahead of its start (none when the setting is
 * empty). A booking made inside that window gets none: its confirmation is still fresh. Each booking is claimed by
 * a conditional update before its e-mail is sent, so several server processes never send it twice; a failed
 * delivery is recorded in mail_dispatches and not retried. Returns how many reminders were attempted.
 */
export async function sendBookingReminders(db: Kysely<Database>, mail: MailContext, now: Date = new Date()): Promise<number> {
  const claimed = await sql<{ id: string; centre_id: string }>`
    update cw_bookings b set reminder_sent_at = ${now}
    from cw_settings s, members m, centres c
    where s.centre_id = b.centre_id and m.id = b.member_id and c.id = b.centre_id
      and 'coworking' = any(c.modules)
      and b.kind = 'booking' and b.status = 'confirmed' and b.reminder_sent_at is null
      and s.reminder_hours is not null and m.email is not null
      and b.starts_at > ${now} and b.starts_at <= ${now}::timestamptz + make_interval(hours => s.reminder_hours)
      and b.requested_at < b.starts_at - make_interval(hours => s.reminder_hours)
    returning b.id, b.centre_id`.execute(db);
  for (const row of claimed.rows) {
    const booking = await loadBooking(db, row.centre_id, row.id);
    await notifyMember(db, mail, row.centre_id, booking, "booking_reminder", {}, null);
  }
  return claimed.rows.length;
}
