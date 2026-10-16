import { addMonthsClamped, mulDivRound } from "@gcf/shared";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import type { Database } from "../../db/types.js";
import type { CwProfile, CwQuotaKind } from "../../db/types.coworking.js";
import type { Db } from "./schedule.js";

const snapshotSchema = z.array(
  z.object({ typeId: z.string(), quotaKind: z.enum(["unlimited", "minutes", "bookings"]), quota: z.number().int().positive().nullable() }),
);

export interface ActiveSubscription {
  id: string;
  planName: string;
  startsOn: string;
  endsOn: string;
  entitlements: { typeId: string; quotaKind: CwQuotaKind; quota: number | null }[];
}

/** Subscriptions of a member active on a local date (status active, starts_on <= date <= ends_on), oldest first. */
export async function activeSubscriptions(db: Db, memberId: string, date: string): Promise<ActiveSubscription[]> {
  const rows = await db
    .selectFrom("cw_subscriptions")
    .innerJoin("cw_plans", "cw_plans.id", "cw_subscriptions.plan_id")
    .select([
      "cw_subscriptions.id",
      "cw_plans.name as planName",
      "cw_subscriptions.starts_on as startsOn",
      "cw_subscriptions.ends_on as endsOn",
      "cw_subscriptions.entitlements",
    ])
    .where("cw_subscriptions.member_id", "=", memberId)
    .where("cw_subscriptions.status", "=", "active")
    .where("cw_subscriptions.starts_on", "<=", date)
    .where("cw_subscriptions.ends_on", ">=", date)
    .orderBy("cw_subscriptions.starts_on")
    .orderBy("cw_subscriptions.created_at")
    .execute();
  return rows.map((r) => {
    const parsed = snapshotSchema.safeParse(r.entitlements);
    return { id: r.id, planName: r.planName, startsOn: r.startsOn, endsOn: r.endsOn, entitlements: parsed.success ? parsed.data : [] };
  });
}

/**
 * Profile of a client on a date (rule 4): "member" with an active subscription, otherwise "visitor". A guest
 * (walk-in client without a portal account) is always a visitor.
 */
export function profileOf(kind: "member" | "guest", subscriptions: ActiveSubscription[]): CwProfile {
  return kind === "member" && subscriptions.length > 0 ? "member" : "visitor";
}

/** First day of the subscription month containing `date`: starts_on plus whole months, clamped to month ends. */
export function windowStart(startsOn: string, date: string): string {
  let months = 0;
  while (addMonthsClamped(startsOn, months + 1) <= date) months += 1;
  return addMonthsClamped(startsOn, months);
}

export interface CoverageSource {
  kind: "subscription" | "pack";
  id: string;
  label: string;
  quotaKind: CwQuotaKind;
  /** What the booking takes from the source: minutes, or 1 for a booking quota. */
  amount: number;
  coveredMinutes: number;
  /** What the source still had before this booking; null for an unlimited quota. */
  availableBefore: number | null;
  windowStart: string | null;
}

export interface Coverage {
  coveredMinutes: number;
  discount: number;
  sources: CoverageSource[];
}

async function usedOnSubscription(db: Db, subscriptionId: string, window: string, typeId: string, quotaKind: CwQuotaKind): Promise<number> {
  const row = await db
    .selectFrom("cw_entitlement_usage")
    .innerJoin("cw_bookings", "cw_bookings.id", "cw_entitlement_usage.booking_id")
    .innerJoin("cw_resources", "cw_resources.id", "cw_bookings.resource_id")
    .select(sql<number>`coalesce(sum(cw_entitlement_usage.amount), 0)::bigint`.as("used"))
    .where("cw_entitlement_usage.subscription_id", "=", subscriptionId)
    .where("cw_entitlement_usage.window_start", "=", window)
    .where("cw_entitlement_usage.quota_kind", "=", quotaKind)
    .where("cw_entitlement_usage.status", "=", "active")
    .where("cw_resources.type_id", "=", typeId)
    .executeTakeFirstOrThrow();
  return row.used;
}

/**
 * Coverage of a booking by the client's entitlements before any promotion (rule 6): the subscription snapshot
 * for the resource type first, then the active packs of the type valid on the booking date by earliest expiry.
 * An unlimited quota covers everything left, a minutes quota up to what remains in its window, a bookings quota
 * the whole remainder for one unit. Call it after locking the member so concurrent bookings see each other's use.
 */
export async function computeCoverage(
  db: Db,
  input: { memberId: string; typeId: string; date: string; minutes: number; listPrice: number; subscriptions: ActiveSubscription[] },
): Promise<Coverage> {
  let remaining = input.minutes;
  const sources: CoverageSource[] = [];
  for (const subscription of input.subscriptions) {
    if (remaining === 0) break;
    const entitlement = subscription.entitlements.find((e) => e.typeId === input.typeId);
    if (!entitlement) continue;
    const window = windowStart(subscription.startsOn, input.date);
    const base = { kind: "subscription" as const, id: subscription.id, label: subscription.planName, quotaKind: entitlement.quotaKind, windowStart: window };
    if (entitlement.quotaKind === "unlimited") {
      sources.push({ ...base, amount: remaining, coveredMinutes: remaining, availableBefore: null });
      remaining = 0;
      continue;
    }
    const available = entitlement.quota! - (await usedOnSubscription(db, subscription.id, window, input.typeId, entitlement.quotaKind));
    if (available <= 0) continue;
    const covered = entitlement.quotaKind === "minutes" ? Math.min(available, remaining) : remaining;
    sources.push({ ...base, amount: entitlement.quotaKind === "minutes" ? covered : 1, coveredMinutes: covered, availableBefore: available });
    remaining -= covered;
  }
  if (remaining > 0) {
    const packs = await db
      .selectFrom("cw_packs")
      .innerJoin("cw_pack_products", "cw_pack_products.id", "cw_packs.product_id")
      .leftJoin(
        db
          .selectFrom("cw_entitlement_usage")
          .select(["pack_id", sql<number>`sum(amount)::bigint`.as("used")])
          .where("status", "=", "active")
          .where("pack_id", "is not", null)
          .groupBy("pack_id")
          .as("u"),
        "u.pack_id",
        "cw_packs.id",
      )
      .select(["cw_packs.id", "cw_pack_products.name", "cw_packs.quota_kind", "cw_packs.quota", sql<number>`coalesce(u.used, 0)`.as("used")])
      .where("cw_packs.member_id", "=", input.memberId)
      .where("cw_packs.type_id", "=", input.typeId)
      .where("cw_packs.status", "=", "active")
      .where("cw_packs.starts_on", "<=", input.date)
      .where("cw_packs.expires_on", ">=", input.date)
      .orderBy("cw_packs.expires_on")
      .orderBy("cw_packs.created_at")
      .execute();
    for (const pack of packs) {
      if (remaining === 0) break;
      const available = pack.quota - Number(pack.used);
      if (available <= 0) continue;
      const covered = pack.quota_kind === "minutes" ? Math.min(available, remaining) : remaining;
      sources.push({
        kind: "pack",
        id: pack.id,
        label: pack.name,
        quotaKind: pack.quota_kind,
        amount: pack.quota_kind === "minutes" ? covered : 1,
        coveredMinutes: covered,
        availableBefore: available,
        windowStart: null,
      });
      remaining -= covered;
    }
  }
  const coveredMinutes = input.minutes - remaining;
  return { coveredMinutes, discount: mulDivRound(input.listPrice, coveredMinutes, input.minutes), sources };
}

/** One usage row per source the booking takes from. */
export async function writeUsage(trx: Transaction<Database>, centreId: string, bookingId: string, coverage: Coverage): Promise<void> {
  if (coverage.sources.length === 0) return;
  await trx
    .insertInto("cw_entitlement_usage")
    .values(
      coverage.sources.map((s) => ({
        centre_id: centreId,
        booking_id: bookingId,
        subscription_id: s.kind === "subscription" ? s.id : null,
        pack_id: s.kind === "pack" ? s.id : null,
        quota_kind: s.quotaKind,
        amount: s.amount,
        window_start: s.windowStart,
      })),
    )
    .execute();
}

/** Gives back to the subscriptions and packs what a booking took. Returns how many rows were released. */
export async function releaseUsage(trx: Transaction<Database>, bookingIds: string[]): Promise<number> {
  if (bookingIds.length === 0) return 0;
  const released = await trx
    .updateTable("cw_entitlement_usage")
    .set({ status: "released" })
    .where("booking_id", "in", bookingIds)
    .where("status", "=", "active")
    .executeTakeFirst();
  return Number(released.numUpdatedRows);
}
