import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/types.js";
import { toClock } from "../validation.js";

export interface WeeklySlot {
  weekday: number;
  startTime: string;
  endTime: string;
  roomId: string | null;
}

export interface SlotConflict {
  type: "room" | "instructor";
  groupId: string;
  groupName: string;
  weekday: number;
  startTime: string;
  endTime: string;
}

export interface SlotCheck {
  centreId: string;
  instructorId: string;
  defaultRoomId: string | null;
  startDate: string;
  endDate: string;
  slots: WeeklySlot[];
  excludeGroupId?: string;
}

/**
 * Weekly-slot conflicts against the other active groups whose period overlaps: same room or same instructor,
 * same weekday, overlapping hours. Dated sessions and rentals are checked again when sessions are generated.
 */
export async function findSlotConflicts(db: Kysely<Database> | Transaction<Database>, check: SlotCheck): Promise<SlotConflict[]> {
  const others = await db
    .selectFrom("group_slots")
    .innerJoin("groups", "groups.id", "group_slots.group_id")
    .select([
      "groups.id as groupId",
      "groups.name as groupName",
      "groups.instructor_id as instructorId",
      "groups.room_id as groupRoomId",
      "group_slots.room_id as slotRoomId",
      "group_slots.weekday",
      "group_slots.start_time as startTime",
      "group_slots.end_time as endTime",
    ])
    .where("groups.centre_id", "=", check.centreId)
    .where("groups.status", "=", "active")
    .where("groups.start_date", "<=", check.endDate)
    .where("groups.end_date", ">=", check.startDate)
    .$if(check.excludeGroupId !== undefined, (qb) => qb.where("groups.id", "!=", check.excludeGroupId!))
    .execute();

  const conflicts: SlotConflict[] = [];
  for (const slot of check.slots) {
    const room = slot.roomId ?? check.defaultRoomId;
    for (const other of others) {
      if (other.weekday !== slot.weekday) continue;
      const overlaps = toClock(other.startTime) < slot.endTime && slot.startTime < toClock(other.endTime);
      if (!overlaps) continue;
      const base = { groupId: other.groupId, groupName: other.groupName, weekday: other.weekday, startTime: toClock(other.startTime), endTime: toClock(other.endTime) };
      const otherRoom = other.slotRoomId ?? other.groupRoomId;
      if (room !== null && otherRoom === room) conflicts.push({ type: "room", ...base });
      if (other.instructorId === check.instructorId) conflicts.push({ type: "instructor", ...base });
    }
  }
  // Two slots of the group being checked must not overlap each other either.
  check.slots.forEach((a, i) => {
    check.slots.slice(i + 1).forEach((b) => {
      if (a.weekday === b.weekday && a.startTime < b.endTime && b.startTime < a.endTime) {
        conflicts.push({ type: "instructor", groupId: check.excludeGroupId ?? "new", groupName: "this group", weekday: a.weekday, startTime: b.startTime, endTime: b.endTime });
      }
    });
  });
  return conflicts;
}
