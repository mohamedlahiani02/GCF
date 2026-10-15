import { addDays, isoWeekday } from "@gcf/shared";
import { sql, type Transaction } from "kysely";
import type { Database } from "../db/types.js";
import { conflict, HttpError, notFound, unprocessable } from "../errors.js";
import { toClock } from "../validation.js";

export interface SessionConflict {
  type: "room" | "instructor" | "group";
  startsAt: Date;
  endsAt: Date;
  description: string;
  sessionId: string | null;
}

export interface SessionWindow {
  centreId: string;
  groupId: string;
  instructorId: string;
  roomId: string | null;
  startsAt: Date;
  endsAt: Date;
  excludeSessionId?: string;
}

/** Everything that would collide with a session at that time: room bookings, the instructor, the group itself. */
export async function findSessionConflicts(trx: Transaction<Database>, w: SessionWindow): Promise<SessionConflict[]> {
  const exclude = w.excludeSessionId ?? "00000000-0000-0000-0000-000000000000";
  const range = sql<string>`tstzrange(${w.startsAt}, ${w.endsAt})`;
  const conflicts: SessionConflict[] = [];

  if (w.roomId) {
    const rooms = await trx
      .selectFrom("room_bookings")
      .leftJoin("class_sessions", "class_sessions.id", "room_bookings.session_id")
      .leftJoin("groups", "groups.id", "class_sessions.group_id")
      .select([
        "room_bookings.session_id as sessionId",
        sql<Date>`lower(room_bookings.period)`.as("startsAt"),
        sql<Date>`upper(room_bookings.period)`.as("endsAt"),
        "groups.name as groupName",
      ])
      .where("room_bookings.room_id", "=", w.roomId)
      .where("room_bookings.active", "=", true)
      .where(sql<boolean>`room_bookings.period && ${range}`)
      .where((eb) => eb.or([eb("room_bookings.session_id", "is", null), eb("room_bookings.session_id", "!=", exclude)]))
      .execute();
    for (const r of rooms) {
      conflicts.push({ type: "room", startsAt: r.startsAt, endsAt: r.endsAt, sessionId: r.sessionId, description: r.groupName ? `room used by ${r.groupName}` : "room already booked" });
    }
  }

  const people = await trx
    .selectFrom("class_sessions")
    .innerJoin("groups", "groups.id", "class_sessions.group_id")
    .select(["class_sessions.id", "class_sessions.starts_at as startsAt", "class_sessions.ends_at as endsAt", "class_sessions.instructor_id as instructorId", "class_sessions.group_id as groupId", "groups.name as groupName"])
    .where("class_sessions.centre_id", "=", w.centreId)
    .where("class_sessions.status", "!=", "cancelled")
    .where("class_sessions.id", "!=", exclude)
    .where((eb) => eb.or([eb("class_sessions.instructor_id", "=", w.instructorId), eb("class_sessions.group_id", "=", w.groupId)]))
    .where(sql<boolean>`tstzrange(class_sessions.starts_at, class_sessions.ends_at) && ${range}`)
    .execute();
  for (const p of people) {
    if (p.groupId === w.groupId) conflicts.push({ type: "group", startsAt: p.startsAt, endsAt: p.endsAt, sessionId: p.id, description: `the group already has a session` });
    else conflicts.push({ type: "instructor", startsAt: p.startsAt, endsAt: p.endsAt, sessionId: p.id, description: `the instructor teaches ${p.groupName}` });
  }
  return conflicts;
}

export const sessionConflictError = (conflicts: SessionConflict[]) =>
  new HttpError(409, "schedule_conflict", "the session conflicts with the planning", { conflicts });

async function centreTimezone(trx: Transaction<Database>, centreId: string): Promise<string> {
  const centre = await trx.selectFrom("centres").select("timezone").where("id", "=", centreId).executeTakeFirstOrThrow();
  return centre.timezone;
}

interface Candidate {
  date: string;
  startTime: string;
  endTime: string;
  roomId: string | null;
}

async function toInstants(trx: Transaction<Database>, tz: string, candidates: Candidate[]): Promise<{ startsAt: Date; endsAt: Date }[]> {
  if (candidates.length === 0) return [];
  const result = await sql<{ starts_at: Date; ends_at: Date; ord: number }>`
    select (x.d + x.s) at time zone ${tz} as starts_at, (x.d + x.e) at time zone ${tz} as ends_at, x.ord
    from unnest(${candidates.map((c) => c.date)}::date[], ${candidates.map((c) => c.startTime)}::time[], ${candidates.map((c) => c.endTime)}::time[])
      with ordinality as x(d, s, e, ord)
    order by x.ord`.execute(trx);
  return result.rows.map((r) => ({ startsAt: r.starts_at, endsAt: r.ends_at }));
}

async function insertSession(trx: Transaction<Database>, values: { centreId: string; groupId: string; instructorId: string; roomId: string | null; startsAt: Date; endsAt: Date }): Promise<string> {
  const session = await trx
    .insertInto("class_sessions")
    .values({ centre_id: values.centreId, group_id: values.groupId, instructor_id: values.instructorId, room_id: values.roomId, starts_at: values.startsAt, ends_at: values.endsAt })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (values.roomId) {
    await trx
      .insertInto("room_bookings")
      .values({ centre_id: values.centreId, room_id: values.roomId, period: sql<string>`tstzrange(${values.startsAt}, ${values.endsAt})` as unknown as string, session_id: session.id })
      .execute();
  }
  return session.id;
}

export interface GenerationResult {
  created: number;
  skippedExisting: number;
  conflicts: (SessionConflict & { candidateStartsAt: Date })[];
}

/**
 * Creates the dated sessions of a group from its weekly slots between two dates (bounded by the group dates).
 * Existing sessions are kept. With conflicts, nothing is created unless `skipConflicts` is set, in which case
 * only the conflict-free sessions are created and the others are reported.
 */
export async function generateGroupSessions(
  trx: Transaction<Database>,
  centreId: string,
  groupId: string,
  from: string,
  to: string,
  skipConflicts: boolean,
): Promise<GenerationResult> {
  const group = await trx
    .selectFrom("groups")
    .select(["id", "instructor_id", "room_id", "start_date", "end_date", "status"])
    .where("id", "=", groupId)
    .where("centre_id", "=", centreId)
    .forUpdate()
    .executeTakeFirst();
  if (!group) throw notFound("group");
  if (group.status !== "active") throw unprocessable("group_archived", "the group is archived");
  const slots = await trx.selectFrom("group_slots").select(["weekday", "start_time", "end_time", "room_id"]).where("group_id", "=", groupId).execute();
  if (slots.length === 0) throw unprocessable("no_slots", "the group has no weekly slot");

  const first = from > group.start_date ? from : group.start_date;
  const last = to < group.end_date ? to : group.end_date;
  if (last < first) return { created: 0, skippedExisting: 0, conflicts: [] };

  const candidates: Candidate[] = [];
  for (let date = first, guard = 0; date <= last; date = addDays(date, 1), guard += 1) {
    if (guard > 800) throw unprocessable("range_too_long", "generate at most two years of sessions at once");
    const weekday = isoWeekday(date);
    for (const s of slots) {
      if (s.weekday === weekday) candidates.push({ date, startTime: toClock(s.start_time), endTime: toClock(s.end_time), roomId: s.room_id ?? group.room_id });
    }
  }
  const tz = await centreTimezone(trx, centreId);
  const instants = await toInstants(trx, tz, candidates);
  const existing = await trx.selectFrom("class_sessions").select("starts_at").where("group_id", "=", groupId).where("status", "!=", "cancelled").execute();
  const existingStarts = new Set(existing.map((e) => e.starts_at.getTime()));

  const toCreate: { startsAt: Date; endsAt: Date; roomId: string | null }[] = [];
  const conflicts: GenerationResult["conflicts"] = [];
  let skippedExisting = 0;
  for (const [index, instant] of instants.entries()) {
    if (existingStarts.has(instant.startsAt.getTime())) {
      skippedExisting += 1;
      continue;
    }
    const roomId = candidates[index]!.roomId;
    const found = await findSessionConflicts(trx, { centreId, groupId, instructorId: group.instructor_id, roomId, ...instant });
    // A session about to be created in this same run also blocks the room.
    const internal = toCreate.filter((c) => c.roomId !== null && c.roomId === roomId && c.startsAt < instant.endsAt && instant.startsAt < c.endsAt);
    if (found.length || internal.length) {
      conflicts.push(...found.map((f) => ({ ...f, candidateStartsAt: instant.startsAt })));
      continue;
    }
    toCreate.push({ ...instant, roomId });
  }
  if (conflicts.length && !skipConflicts) throw sessionConflictError(conflicts);
  for (const c of toCreate) {
    await insertSession(trx, { centreId, groupId, instructorId: group.instructor_id, roomId: c.roomId, startsAt: c.startsAt, endsAt: c.endsAt });
  }
  return { created: toCreate.length, skippedExisting, conflicts };
}

/** A one-off session (extra or make-up date) for a group. */
export async function createSingleSession(
  trx: Transaction<Database>,
  centreId: string,
  groupId: string,
  input: { date: string; startTime: string; endTime: string; roomId: string | null; instructorId?: string | undefined },
): Promise<string> {
  const group = await trx.selectFrom("groups").select(["instructor_id", "room_id", "status"]).where("id", "=", groupId).where("centre_id", "=", centreId).executeTakeFirst();
  if (!group) throw notFound("group");
  if (group.status !== "active") throw unprocessable("group_archived", "the group is archived");
  const tz = await centreTimezone(trx, centreId);
  const [instant] = await toInstants(trx, tz, [{ date: input.date, startTime: input.startTime, endTime: input.endTime, roomId: input.roomId }]);
  const roomId = input.roomId ?? group.room_id;
  const instructorId = input.instructorId ?? group.instructor_id;
  const conflicts = await findSessionConflicts(trx, { centreId, groupId, instructorId, roomId, ...instant! });
  if (conflicts.length) throw sessionConflictError(conflicts);
  return insertSession(trx, { centreId, groupId, instructorId, roomId, ...instant! });
}

/** Moves a session (planning drag and drop), checking every conflict before saving. */
export async function moveSession(
  trx: Transaction<Database>,
  centreId: string,
  sessionId: string,
  input: { startsAt: Date; endsAt: Date; roomId: string | null; instructorId?: string | undefined },
): Promise<void> {
  const session = await trx.selectFrom("class_sessions").select(["id", "group_id", "instructor_id", "status", "sheet_status"]).where("id", "=", sessionId).where("centre_id", "=", centreId).forUpdate().executeTakeFirst();
  if (!session) throw notFound("session");
  if (session.status !== "scheduled" || session.sheet_status === "validated") throw conflict("session_locked", "only a scheduled session can be moved");
  if (input.endsAt <= input.startsAt) throw unprocessable("invalid_times", "the session must end after it starts");
  const instructorId = input.instructorId ?? session.instructor_id;
  await trx.updateTable("room_bookings").set({ active: false }).where("session_id", "=", sessionId).where("active", "=", true).execute();
  const conflicts = await findSessionConflicts(trx, { centreId, groupId: session.group_id, instructorId, roomId: input.roomId, startsAt: input.startsAt, endsAt: input.endsAt, excludeSessionId: sessionId });
  if (conflicts.length) throw sessionConflictError(conflicts);
  await trx.updateTable("class_sessions").set({ starts_at: input.startsAt, ends_at: input.endsAt, room_id: input.roomId, instructor_id: instructorId }).where("id", "=", sessionId).execute();
  if (input.roomId) {
    await trx
      .insertInto("room_bookings")
      .values({ centre_id: centreId, room_id: input.roomId, period: sql<string>`tstzrange(${input.startsAt}, ${input.endsAt})` as unknown as string, session_id: sessionId })
      .execute();
  }
}

/** A cancelled session frees its room, is never billed and never paid. */
export async function cancelSession(trx: Transaction<Database>, centreId: string, sessionId: string, reason: string): Promise<void> {
  const session = await trx.selectFrom("class_sessions").select(["status", "sheet_status"]).where("id", "=", sessionId).where("centre_id", "=", centreId).forUpdate().executeTakeFirst();
  if (!session) throw notFound("session");
  if (session.status === "cancelled") return;
  if (session.sheet_status !== "none") throw conflict("session_has_attendance", "a session with attendance cannot be cancelled");
  await trx.updateTable("class_sessions").set({ status: "cancelled", cancel_reason: reason }).where("id", "=", sessionId).execute();
  await trx.updateTable("room_bookings").set({ active: false }).where("session_id", "=", sessionId).execute();
}
