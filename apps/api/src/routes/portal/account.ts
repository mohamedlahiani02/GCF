import { addDays, addMonthsClamped } from "@gcf/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { activeSubscriptions, windowStart, type ActiveSubscription } from "../../domain/coworking/entitlements.js";
import { centreClock, installmentBalances, payerTotals, type Payer } from "../../domain/ledger.js";
import { notFound } from "../../errors.js";
import { idParam } from "../../validation.js";
import { signedIn } from "./context.js";

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/** First day of the subscription month after the one starting on `start`: the day the quotas restart. */
function nextWindowStart(startsOn: string, start: string): string {
  let months = 1;
  while (addMonthsClamped(startsOn, months) <= start) months += 1;
  return addMonthsClamped(startsOn, months);
}

/** Subscriptions, credit packs, money, receipts and domiciliation mail of the signed-in member (portal). */
export const portalAccountRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;

  /**
   * Current and upcoming subscriptions with, for each entitlement, its quota and what remains in the subscription
   * month containing today (the first month for an upcoming subscription). Use is counted like computeCoverage
   * counts it: active usage rows of the window, for bookings of the entitlement's resource type.
   */
  app.get("/subscription", async (request) => {
    const { centre, member } = await signedIn(db, request);
    const { today } = await centreClock(db, centre.id);
    const rows = await db
      .selectFrom("cw_subscriptions as s")
      .innerJoin("cw_plans as p", "p.id", "s.plan_id")
      .leftJoin("cw_resources as r", "r.id", "s.assigned_resource_id")
      .select([
        "s.id",
        "p.name as planName",
        "s.starts_on as startsOn",
        "s.ends_on as endsOn",
        "s.price",
        "s.billing",
        "s.includes_domiciliation as includesDomiciliation",
        "s.assigned_resource_id as assignedResourceId",
        "r.code as assignedResourceCode",
        "s.auto_renew as autoRenew",
      ])
      .where("s.member_id", "=", member.memberId)
      .where("s.centre_id", "=", centre.id)
      .where("s.status", "=", "active")
      .where("s.ends_on", ">=", today)
      .orderBy("s.starts_on")
      .orderBy("s.created_at")
      .execute();
    const snapshots = new Map<string, ActiveSubscription[]>();
    const entitlementsOf = async (id: string, date: string) => {
      if (!snapshots.has(date)) snapshots.set(date, await activeSubscriptions(db, member.memberId, date));
      return snapshots.get(date)!.find((s) => s.id === id)?.entitlements ?? [];
    };
    const subscriptions = [];
    for (const row of rows) {
      const current = row.startsOn <= today;
      const start = current ? windowStart(row.startsOn, today) : row.startsOn;
      const next = nextWindowStart(row.startsOn, start);
      subscriptions.push({ ...row, state: current ? "current" : "upcoming", window: { start, end: next <= row.endsOn ? addDays(next, -1) : row.endsOn } });
    }
    const entitlements = await Promise.all(subscriptions.map((s) => entitlementsOf(s.id, s.state === "current" ? today : s.startsOn)));
    const typeIds = [...new Set(entitlements.flat().map((e) => e.typeId))];
    const types = typeIds.length ? await db.selectFrom("cw_resource_types").select(["id", "name", "category"]).where("id", "in", typeIds).execute() : [];
    const usage = rows.length
      ? await db
          .selectFrom("cw_entitlement_usage as u")
          .innerJoin("cw_bookings as b", "b.id", "u.booking_id")
          .innerJoin("cw_resources as r", "r.id", "b.resource_id")
          .select([
            "u.subscription_id as subscriptionId",
            "u.window_start as windowStart",
            "u.quota_kind as quotaKind",
            "r.type_id as typeId",
            sql<number>`sum(u.amount)::bigint`.as("used"),
          ])
          .where(
            "u.subscription_id",
            "in",
            rows.map((r) => r.id),
          )
          .where("u.status", "=", "active")
          .groupBy(["u.subscription_id", "u.window_start", "u.quota_kind", "r.type_id"])
          .execute()
      : [];
    return {
      items: subscriptions.map((s, i) => ({
        ...s,
        entitlements: entitlements[i]!.map((e) => {
          const type = types.find((t) => t.id === e.typeId);
          const used =
            e.quotaKind === "unlimited"
              ? null
              : (usage.find((u) => u.subscriptionId === s.id && u.windowStart === s.window.start && u.quotaKind === e.quotaKind && u.typeId === e.typeId)
                  ?.used ?? 0);
          return {
            typeId: e.typeId,
            typeName: type?.name ?? null,
            category: type?.category ?? null,
            quotaKind: e.quotaKind,
            quota: e.quota,
            used,
            remaining: e.quota === null || used === null ? null : Math.max(e.quota - used, 0),
          };
        }),
      })),
    };
  });

  /** Credit packs with what remains of them; used, expired and cancelled packs stay visible as history. */
  app.get("/packs", async (request) => {
    const { centre, member } = await signedIn(db, request);
    const { today } = await centreClock(db, centre.id);
    const rows = await db
      .selectFrom("cw_packs as k")
      .innerJoin("cw_pack_products as pp", "pp.id", "k.product_id")
      .innerJoin("cw_resource_types as t", "t.id", "k.type_id")
      .select([
        "k.id",
        "pp.name as productName",
        "k.type_id as typeId",
        "t.name as typeName",
        "t.category",
        "k.quota_kind as quotaKind",
        "k.quota",
        "k.price",
        "k.starts_on as startsOn",
        "k.expires_on as expiresOn",
        "k.status",
        sql<number>`coalesce((select sum(u.amount) from cw_entitlement_usage u where u.pack_id = k.id and u.status = 'active'), 0)::integer`.as("used"),
      ])
      .where("k.member_id", "=", member.memberId)
      .where("k.centre_id", "=", centre.id)
      .orderBy("k.expires_on", "desc")
      .orderBy("k.created_at", "desc")
      .execute();
    return {
      items: rows.map((p) => {
        const remaining = Math.max(p.quota - p.used, 0);
        const state = p.status === "cancelled" ? "cancelled" : p.expiresOn < today ? "expired" : remaining === 0 ? "used_up" : "active";
        return { ...p, remaining, state };
      }),
    };
  });

  /** Balances, charges with their payment state and payments with their receipts, like the staff member account. */
  app.get("/account", async (request) => {
    const { centre, member } = await signedIn(db, request);
    const payer: Payer = { kind: "member", id: member.memberId };
    const installments = await installmentBalances(db, centre.id, { payer });
    const payments = await db
      .selectFrom("payments")
      .leftJoin("receipts", (join) => join.onRef("receipts.payment_id", "=", "payments.id").on("receipts.kind", "!=", "cancellation"))
      .select([
        "payments.id",
        "payments.kind",
        "payments.received_at as receivedAt",
        "payments.amount",
        "payments.method",
        "payments.cheque_status as chequeStatus",
        "payments.status",
        "receipts.id as receiptId",
        "receipts.number as receiptNumber",
      ])
      .where("payments.member_id", "=", member.memberId)
      .where("payments.centre_id", "=", centre.id)
      .orderBy("payments.received_at", "desc")
      .execute();
    return {
      totals: await payerTotals(db, centre.id, payer),
      installments: installments.map((i) => ({
        id: i.id,
        label: i.label,
        kind: i.kind,
        amount: i.amount,
        dueDate: i.dueDate,
        status: i.status,
        paid: i.paid,
        remaining: i.remaining,
        state: i.state,
        cwBookingId: i.cwBookingId,
        cwSubscriptionId: i.cwSubscriptionId,
        cwPackId: i.cwPackId,
      })),
      payments,
    };
  });

  /** The archived receipt of one of the member's payments. Viewing is not printing: nothing is logged. */
  app.get("/receipts/:id/pdf", async (request, reply) => {
    const { centre, member } = await signedIn(db, request);
    const { id } = idParam.parse(request.params);
    const receipt = await db
      .selectFrom("receipts")
      .innerJoin("payments", "payments.id", "receipts.payment_id")
      .select(["receipts.number", "receipts.pdf"])
      .where("receipts.id", "=", id)
      .where("receipts.centre_id", "=", centre.id)
      .where("payments.member_id", "=", member.memberId)
      .executeTakeFirst();
    if (!receipt) throw notFound("receipt");
    return reply
      .header("content-type", "application/pdf")
      .header("content-disposition", `inline; filename="${receipt.number}.pdf"`)
      .header("cache-control", "private, no-store")
      .send(receipt.pdf);
  });

  /** Domiciliation mail received for the member, the newest first. */
  app.get("/mail", async (request) => {
    const { centre, member } = await signedIn(db, request);
    const query = pageQuery.parse(request.query);
    const rows = await db
      .selectFrom("cw_mail_items")
      .select([
        "id",
        "received_at as receivedAt",
        "kind",
        "sender",
        "reference",
        "status",
        "notified_at as notifiedAt",
        "collected_at as collectedAt",
        "collected_by_name as collectedByName",
      ])
      .where("member_id", "=", member.memberId)
      .where("centre_id", "=", centre.id)
      .orderBy("received_at", "desc")
      .orderBy("id")
      .limit(query.pageSize + 1)
      .offset((query.page - 1) * query.pageSize)
      .execute();
    return { items: rows.slice(0, query.pageSize), hasMore: rows.length > query.pageSize, page: query.page };
  });
};
