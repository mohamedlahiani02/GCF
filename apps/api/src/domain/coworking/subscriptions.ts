import { addDays, addMonthsClamped, allocate } from "@gcf/shared";
import { sql, type Kysely, type Transaction } from "kysely";
import type { CwBilling, CwPeriod, CwQuotaKind } from "../../db/types.coworking.js";
import type { Database } from "../../db/types.js";
import { writeAudit } from "../../audit.js";
import { conflict, HttpError, notFound, unprocessable } from "../../errors.js";
import { lockPayer, settlePayer, type Payer } from "../ledger.js";
import { issueMemberCharges, type ChargeLine } from "./memberCharges.js";

const PERIOD_MONTHS: Record<CwPeriod, number> = { month: 1, quarter: 3, year: 12 };

/** One quota of the plan as sold, stored in cw_subscriptions.entitlements. */
export interface EntitlementSnapshot {
  typeId: string;
  quotaKind: CwQuotaKind;
  quota: number | null;
}

export interface PlanForSale {
  id: string;
  name: string;
  period: CwPeriod;
  price: number;
  billing: CwBilling;
  includesDomiciliation: boolean;
  assignedTypeId: string | null;
  status: "active" | "archived";
  entitlements: EntitlementSnapshot[];
}

const frDate = (iso: string) => iso.split("-").reverse().join("/");

/** Last day of a subscription period: the start date plus the period, minus one day. */
export function periodEnd(startsOn: string, period: CwPeriod): string {
  return addDays(addMonthsClamped(startsOn, PERIOD_MONTHS[period]), -1);
}

/** Upfront: one charge due on the first day. Monthly: one charge per month of the period, rounding spread by allocate(). */
export function subscriptionChargeLines(planName: string, price: number, billing: CwBilling, period: CwPeriod, startsOn: string, endsOn: string): ChargeLine[] {
  if (billing === "upfront") return [{ label: `Abonnement ${planName} du ${frDate(startsOn)} au ${frDate(endsOn)}`, amount: price, dueDate: startsOn }];
  const months = PERIOD_MONTHS[period];
  return allocate(
    price,
    Array.from({ length: months }, () => 1),
  ).map((amount, i) => {
    const dueDate = addMonthsClamped(startsOn, i);
    return { label: `Abonnement ${planName}, mensualité ${i + 1}/${months} (${frDate(dueDate)})`, amount, dueDate };
  });
}

/** The plan with its current quotas, as a new subscription or a renewal takes them. */
export async function loadPlanForSale(db: Kysely<Database> | Transaction<Database>, centreId: string, planId: string): Promise<PlanForSale | undefined> {
  const plan = await db
    .selectFrom("cw_plans")
    .select(["id", "name", "period", "price", "billing", "includes_domiciliation as includesDomiciliation", "assigned_type_id as assignedTypeId", "status"])
    .where("id", "=", planId)
    .where("centre_id", "=", centreId)
    .executeTakeFirst();
  if (!plan) return undefined;
  const entitlements = await db
    .selectFrom("cw_plan_entitlements")
    .select(["type_id as typeId", "quota_kind as quotaKind", "quota"])
    .where("plan_id", "=", planId)
    .orderBy("type_id")
    .execute();
  return { ...plan, entitlements };
}

/**
 * Checks the resource given to a plan with an assigned type: a resource of that type, usable, and not assigned to
 * another active subscription over the period. Renewals keep a resource that is temporarily out of service.
 */
export async function assertAssignableResource(
  trx: Transaction<Database>,
  centreId: string,
  typeId: string,
  resourceId: string,
  startsOn: string,
  endsOn: string,
  options: { allowOutOfService: boolean },
): Promise<void> {
  const resource = await trx
    .selectFrom("cw_resources")
    .select(["id", "type_id", "status"])
    .where("id", "=", resourceId)
    .where("centre_id", "=", centreId)
    .forUpdate()
    .executeTakeFirst();
  const usable = resource && (resource.status === "active" || (options.allowOutOfService && resource.status === "out_of_service"));
  if (!resource || resource.type_id !== typeId || !usable)
    throw unprocessable("invalid_assigned_resource", "the resource is not an available resource of the plan type");
  const taken = await trx
    .selectFrom("cw_subscriptions")
    .select("id")
    .where("assigned_resource_id", "=", resourceId)
    .where("status", "=", "active")
    .where("starts_on", "<=", endsOn)
    .where("ends_on", ">=", startsOn)
    .executeTakeFirst();
  if (taken) throw conflict("resource_taken", "the resource is already assigned to another subscription over this period");
}

export interface NewSubscription {
  centreId: string;
  memberId: string;
  plan: PlanForSale;
  startsOn: string;
  assignedResourceId: string | null;
  autoRenew: boolean;
  renewedFromId: string | null;
  userId: string | null;
}

/**
 * Settles a member after a change made by the background job. settlePayer attributes allocations to a user; the job
 * has none, so the same plan is applied with an empty author.
 */
/**
 * Sells a subscription: snapshots the plan price and quotas, creates its charges and lets the member's credit pay
 * them. The caller locks the member first and checks the assigned resource. Two active subscriptions can never hold
 * the same resource on the same day: the exclusion constraint answers 409 resource_taken on a race.
 */
export async function createSubscription(trx: Transaction<Database>, input: NewSubscription): Promise<{ id: string; startsOn: string; endsOn: string }> {
  const { plan } = input;
  const endsOn = periodEnd(input.startsOn, plan.period);
  let row: { id: string };
  try {
    row = await trx
      .insertInto("cw_subscriptions")
      .values({
        centre_id: input.centreId,
        member_id: input.memberId,
        plan_id: plan.id,
        starts_on: input.startsOn,
        ends_on: endsOn,
        price: plan.price,
        billing: plan.billing,
        includes_domiciliation: plan.includesDomiciliation,
        entitlements: JSON.stringify(plan.entitlements),
        assigned_resource_id: input.assignedResourceId,
        auto_renew: input.autoRenew,
        renewed_from_id: input.renewedFromId,
        created_by: input.userId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23P01") {
      throw conflict("resource_taken", "the resource is already assigned to another subscription over this period");
    }
    throw error;
  }
  const lines = subscriptionChargeLines(plan.name, plan.price, plan.billing, plan.period, input.startsOn, endsOn);
  await issueMemberCharges(trx, input.centreId, input.memberId, { cwSubscriptionId: row.id }, lines, input.userId);
  const payer: Payer = { kind: "member", id: input.memberId };
  await settlePayer(trx, input.centreId, payer, input.userId);
  return { id: row.id, startsOn: input.startsOn, endsOn };
}

/**
 * Creates the next period of a subscription from the day after its end, at the plan's current price and quotas,
 * with the same assigned resource. `anyRenewal` makes a renewal that was cancelled count as existing, so the
 * background job never recreates what the staff cancelled.
 */
export async function renewSubscription(
  trx: Transaction<Database>,
  centreId: string,
  subscriptionId: string,
  options: { userId: string | null; anyRenewal: boolean },
): Promise<{ id: string; startsOn: string; endsOn: string }> {
  const source = await trx
    .selectFrom("cw_subscriptions")
    .select(["id", "member_id", "plan_id", "ends_on", "status", "auto_renew", "assigned_resource_id"])
    .where("id", "=", subscriptionId)
    .where("centre_id", "=", centreId)
    .forUpdate()
    .executeTakeFirst();
  if (!source) throw notFound("subscription");
  if (source.status !== "active") throw conflict("subscription_cancelled", "a cancelled subscription cannot be renewed");
  const existing = await trx
    .selectFrom("cw_subscriptions")
    .select("id")
    .where("renewed_from_id", "=", subscriptionId)
    .$if(!options.anyRenewal, (qb) => qb.where("status", "=", "active"))
    .executeTakeFirst();
  if (existing) throw conflict("already_renewed", "this subscription has already been renewed");
  await lockPayer(trx, { kind: "member", id: source.member_id }, centreId);
  const member = await trx.selectFrom("members").select("status").where("id", "=", source.member_id).executeTakeFirstOrThrow();
  if (member.status === "disabled") throw conflict("member_disabled", "the member is disabled");
  const plan = await loadPlanForSale(trx, centreId, source.plan_id);
  if (!plan || plan.status !== "active") throw conflict("plan_archived", "the plan of this subscription is archived");
  const startsOn = addDays(source.ends_on, 1);
  if (plan.assignedTypeId && source.assigned_resource_id) {
    await assertAssignableResource(trx, centreId, plan.assignedTypeId, source.assigned_resource_id, startsOn, periodEnd(startsOn, plan.period), {
      allowOutOfService: true,
    });
  } else if (plan.assignedTypeId) {
    throw conflict("assigned_resource_required", "the plan now assigns a resource: create the next subscription with one");
  }
  return createSubscription(trx, {
    centreId,
    memberId: source.member_id,
    plan,
    startsOn,
    assignedResourceId: plan.assignedTypeId ? source.assigned_resource_id : null,
    autoRenew: source.auto_renew,
    renewedFromId: source.id,
    userId: options.userId,
  });
}

/**
 * Creates the next period of subscriptions marked for automatic renewal that end today or earlier in their centre's
 * time zone. Each renewal runs in its own transaction under a row lock and re-checks that no renewal exists, so
 * several processes may run it at once. A subscription that cannot be renewed (archived plan, disabled member,
 * resource taken) is left as it is. Returns how many renewals were created.
 */
export async function autoRenewSubscriptions(db: Kysely<Database>, now: Date = new Date()): Promise<number> {
  const candidates = await db
    .selectFrom("cw_subscriptions as s")
    .innerJoin("centres as c", "c.id", "s.centre_id")
    .select(["s.id", "s.centre_id as centreId"])
    .where("s.status", "=", "active")
    .where("s.auto_renew", "=", true)
    .where(sql<boolean>`s.ends_on <= (${now}::timestamptz at time zone c.timezone)::date`)
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom("cw_subscriptions as r").select("r.id").whereRef("r.renewed_from_id", "=", "s.id"))))
    .orderBy("s.ends_on")
    .execute();
  let created = 0;
  for (const candidate of candidates) {
    try {
      const renewed = await db.transaction().execute(async (trx) => {
        const locked = await trx
          .selectFrom("cw_subscriptions")
          .select("id")
          .where("id", "=", candidate.id)
          .where("status", "=", "active")
          .where("auto_renew", "=", true)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (!locked) return false;
        const next = await renewSubscription(trx, candidate.centreId, candidate.id, { userId: null, anyRenewal: true });
        await writeAudit(trx, {
          centreId: candidate.centreId,
          userId: null,
          action: "cw_subscription.renewed",
          objectType: "cw_subscription",
          objectId: next.id,
          after: { ...next, renewedFromId: candidate.id, automatic: true },
        });
        return true;
      });
      if (renewed) created += 1;
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
    }
  }
  return created;
}
