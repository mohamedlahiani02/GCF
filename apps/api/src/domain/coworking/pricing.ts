import { mulDivRound, percentOf } from "@gcf/shared";
import { sql } from "kysely";
import type { CwExtraPricing, CwProfile } from "../../db/types.coworking.js";
import { unprocessable } from "../../errors.js";
import type { Db } from "./schedule.js";

export interface ListPrice {
  /** Price of the booking before coverage and promotion. */
  listPrice: number;
  /** Amount of the price row used: the price of the format, or its hourly rate for a free format. */
  rate: number;
  /** Profile of the price row actually used (a member falls back to the visitor price). */
  priceProfile: CwProfile;
  offpeak: boolean;
}

/**
 * Price of a format for a profile (rule 5): a missing member price falls back to the visitor price, no price at
 * all means the format is not for sale. The off-peak amount applies from the centre's off-peak time when the
 * row has one. Free formats are priced per hour.
 */
export async function listPrice(
  db: Db,
  format: { id: string; nature: string; longFromMinutes?: number | null; capMinutes?: number | null },
  profile: CwProfile,
  startTime: string,
  minutes: number,
  offpeakFrom: string | null,
): Promise<ListPrice> {
  const rows = await db.selectFrom("cw_prices").select(["profile", "amount", "offpeak_amount", "long_amount"]).where("format_id", "=", format.id).execute();
  const row = rows.find((r) => r.profile === profile) ?? rows.find((r) => r.profile === "visitor");
  if (!row) throw unprocessable("no_price", "this format has no price and is not for sale");
  const offpeak = offpeakFrom !== null && startTime >= offpeakFrom && row.offpeak_amount !== null;
  if (format.nature !== "free")
    return { listPrice: offpeak ? row.offpeak_amount! : row.amount, rate: offpeak ? row.offpeak_amount! : row.amount, priceProfile: row.profile, offpeak };
  // Hourly formats: the lowest applicable rate wins (off-peak, long booking), and minutes beyond the cap are free.
  const longRate = format.longFromMinutes != null && minutes >= format.longFromMinutes && row.long_amount !== null ? row.long_amount : null;
  const rate = Math.min(row.amount, offpeak ? row.offpeak_amount! : row.amount, longRate ?? row.amount);
  const billed = format.capMinutes != null ? Math.min(minutes, format.capMinutes) : minutes;
  return { listPrice: mulDivRound(rate, billed, 60), rate, priceProfile: row.profile, offpeak: offpeak && rate === row.offpeak_amount };
}

/** Splits an amount that includes tax into its net part and its tax, for a rate in basis points. */
export function taxIncluded(amount: number, rateBp: number): { net: number; tax: number; rateBp: number } {
  const net = mulDivRound(amount, 10_000, 10_000 + rateBp);
  return { net, tax: amount - net, rateBp };
}

export interface AppliedPromotion {
  id: string;
  code: string;
  kind: "percent" | "amount";
  value: number;
  discount: number;
}

/**
 * Validates a promotion code and computes its discount on what remains after coverage (rule 7). Uses are the
 * bookings carrying the code that were not refused, expired or cancelled. With `lock` the code row is locked so
 * two bookings cannot take its last use at the same time.
 */
export async function applyPromotion(
  db: Db,
  centreId: string,
  rawCode: string,
  profile: CwProfile,
  today: string,
  remaining: number,
  options: { lock?: boolean } = {},
): Promise<AppliedPromotion> {
  const code = rawCode.trim().toUpperCase();
  const promo = await db
    .selectFrom("cw_promo_codes")
    .select(["id", "code", "kind", "value", "valid_from", "valid_to", "max_uses", "profiles", "status"])
    .where("centre_id", "=", centreId)
    .where("code", "=", code)
    .$if(options.lock === true, (qb) => qb.forUpdate())
    .executeTakeFirst();
  if (!promo || promo.status !== "active") throw unprocessable("promo_unknown", "this promotion code does not exist");
  if (today < promo.valid_from || today > promo.valid_to) throw unprocessable("promo_expired", "this promotion code is not valid today");
  if (!promo.profiles.includes(profile)) throw unprocessable("promo_not_applicable", "this promotion code does not apply to this client");
  if (promo.max_uses !== null) {
    const used = await db
      .selectFrom("cw_bookings")
      .select(sql<number>`count(*)::integer`.as("uses"))
      .where("promo_code_id", "=", promo.id)
      .where("status", "not in", ["refused", "expired", "cancelled"])
      .executeTakeFirstOrThrow();
    if (used.uses >= promo.max_uses) throw unprocessable("promo_exhausted", "this promotion code has no use left");
  }
  const discount = promo.kind === "percent" ? percentOf(remaining, promo.value) : Math.min(promo.value, remaining);
  return { id: promo.id, code: promo.code, kind: promo.kind, value: promo.value, discount };
}

export interface ExtraRequest {
  extraId: string;
  quantity: number;
}

export interface ExtraLine {
  extraId: string;
  name: string;
  pricing: CwExtraPricing;
  quantity: number;
  unitAmount: number;
  amount: number;
}

/**
 * Prices the extras asked for a booking of a resource type. Each extra must be active and belong to that type, and
 * be public for a portal request. A fixed extra is taken once; the others up to their maximum quantity. A subscriber
 * pays the subscriber price when the extra has one.
 */
export async function priceExtras(
  db: Db,
  centreId: string,
  typeId: string,
  profile: CwProfile,
  requested: ExtraRequest[],
  options: { portal: boolean },
): Promise<ExtraLine[]> {
  if (requested.length === 0) return [];
  const ids = requested.map((r) => r.extraId);
  if (new Set(ids).size !== ids.length) throw unprocessable("extra_repeated", "an extra is listed more than once");
  const rows = await db
    .selectFrom("cw_extras")
    .select(["id", "name", "pricing", "amount", "member_amount", "max_quantity", "public", "status", "type_id"])
    .where("centre_id", "=", centreId)
    .where("id", "in", ids)
    .execute();
  return requested.map((r) => {
    const extra = rows.find((row) => row.id === r.extraId);
    if (!extra || extra.status !== "active" || extra.type_id !== typeId || (options.portal && !extra.public)) {
      throw unprocessable("extra_unavailable", "this extra cannot be added to this resource");
    }
    if (extra.pricing === "fixed" ? r.quantity !== 1 : r.quantity > extra.max_quantity) {
      throw unprocessable("extra_quantity", `at most ${extra.pricing === "fixed" ? 1 : extra.max_quantity} of this extra per booking`);
    }
    const unitAmount = profile === "member" && extra.member_amount !== null ? extra.member_amount : extra.amount;
    return { extraId: extra.id, name: extra.name, pricing: extra.pricing, quantity: r.quantity, unitAmount, amount: unitAmount * r.quantity };
  });
}
