import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
let accountant: string;
const ids: Record<string, string> = {};
const RANGE = "from=2027-01-04&to=2027-01-05";

async function insertPlan(name: string, period: "month" | "quarter" | "year", price: number): Promise<string> {
  const row = await h.db
    .insertInto("cw_plans")
    .values({ centre_id: h.centreId, name, period, price, billing: "upfront" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertSubscription(memberId: string, planId: string, price: number, startsOn: string, endsOn: string, cancelled = false): Promise<string> {
  const row = await h.db
    .insertInto("cw_subscriptions")
    .values({
      centre_id: h.centreId,
      member_id: memberId,
      plan_id: planId,
      starts_on: startsOn,
      ends_on: endsOn,
      price,
      billing: "upfront",
      includes_domiciliation: false,
      ...(cancelled ? { status: "cancelled" as const, cancelled_at: "2027-01-02T10:00:00Z", cancel_reason: "erreur" } : {}),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

interface Row {
  resource: string;
  member: string;
  status: "requested" | "confirmed" | "checked_in" | "completed" | "cancelled" | "refused" | "expired" | "no_show";
  startsAt: string;
  endsAt: string;
  requestedAt: string;
  charge?: number;
  checkedInAt?: string;
  cancelledAt?: string;
}

async function insertBooking(row: Row): Promise<string> {
  const charge = row.charge ?? 0;
  const created = await h.db
    .insertInto("cw_bookings")
    .values({
      centre_id: h.centreId,
      kind: "booking",
      resource_id: ids[row.resource]!,
      member_id: ids[row.member]!,
      starts_at: row.startsAt,
      ends_at: row.endsAt,
      blocked_until: row.endsAt,
      status: row.status,
      source: "staff",
      profile: "visitor",
      list_price: charge,
      charge,
      requested_at: row.requestedAt,
      checked_in_at: row.checkedInAt ?? null,
      cancelled_at: row.cancelledAt ?? null,
      cancel_reason: row.cancelledAt ? "annulation" : null,
      refusal_reason: row.status === "refused" ? "complet" : null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return created.id;
}

async function insertCharge(
  memberId: string,
  owner: { cw_booking_id?: string; cw_subscription_id?: string; cw_pack_id?: string },
  amount: number,
  dueDate: string,
  status: "open" | "cancelled" = "open",
) {
  const row = await h.db
    .insertInto("installments")
    .values({
      centre_id: h.centreId,
      enrolment_id: null,
      member_id: memberId,
      ...owner,
      label: "Coworking",
      kind: "charge",
      amount,
      due_date: dueDate,
      original_due_date: dueDate,
      discount_status: null,
      ...(status === "cancelled" ? { status, cancelled_at: "2027-01-04T08:00:00Z", cancel_reason: "annulée" } : {}),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function pay(memberId: string, receivedAt: string, allocations: { installmentId: string; amount: number }[]) {
  const amount = allocations.reduce((s, a) => s + a.amount, 0);
  const payment = await h.db
    .insertInto("payments")
    .values({ centre_id: h.centreId, member_id: memberId, received_at: receivedAt, amount, method: "cash" })
    .returning("id")
    .executeTakeFirstOrThrow();
  await h.db
    .insertInto("allocations")
    .values(allocations.map((a) => ({ centre_id: h.centreId, payment_id: payment.id, installment_id: a.installmentId, amount: a.amount })))
    .execute();
}

beforeAll(async () => {
  h = await createHarness();
  await h.setModules(["coworking"]);
  await h.createUser("accountant", "compta@stats.test");
  await h.createUser("secretariat", "sec@stats.test");
  accountant = await h.login("compta@stats.test");
  await h.db
    .updateTable("centres")
    .set({ open_from: "08:00", open_to: "18:00", open_weekdays: [1, 2, 3, 4, 5, 6, 7] })
    .where("id", "=", h.centreId)
    .execute();
  await h.db.insertInto("cw_settings").values({ centre_id: h.centreId, free_cancel_hours: 24 }).execute();
  await h.db
    .insertInto("cw_closures")
    .values({ centre_id: h.centreId, starts_on: "2027-01-05", ends_on: "2027-01-05", label: "Demi-journée", open_from: "08:00", open_to: "13:00" })
    .execute();
  const floor = await h.db.insertInto("cw_floors").values({ centre_id: h.centreId, name: "Étage 1" }).returning("id").executeTakeFirstOrThrow();
  const type = async (name: string, category: "hot_desk" | "meeting_room" | "dedicated_desk", position: number) =>
    (await h.db.insertInto("cw_resource_types").values({ centre_id: h.centreId, name, category, position }).returning("id").executeTakeFirstOrThrow()).id;
  ids.hot = await type("Open space", "hot_desk", 1);
  ids.meet = await type("Salle", "meeting_room", 2);
  ids.ded = await type("Bureau dédié", "dedicated_desk", 3);
  for (const [code, typeId] of [
    ["A1", ids.hot],
    ["A2", ids.hot],
    ["R1", ids.meet],
    ["D1", ids.ded],
  ] as const) {
    ids[code] = (
      await h.db
        .insertInto("cw_resources")
        .values({ centre_id: h.centreId, type_id: typeId, floor_id: floor.id, code })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  }
  for (const name of ["Xavier", "Yasmine"]) {
    ids[name] = (
      await h.db.insertInto("members").values({ centre_id: h.centreId, kind: "member", first_name: name }).returning("id").executeTakeFirstOrThrow()
    ).id;
  }

  // Times are in UTC; Tunis is UTC+1, so 08:00Z is 09:00 local.
  const b1 = await insertBooking({
    resource: "A1",
    member: "Xavier",
    status: "completed",
    startsAt: "2027-01-04T08:00:00Z",
    endsAt: "2027-01-04T10:00:00Z",
    requestedAt: "2027-01-03T08:00:00Z",
    charge: 20_000,
    checkedInAt: "2027-01-04T08:05:00Z",
  });
  const b2 = await insertBooking({
    resource: "A1",
    member: "Xavier",
    status: "no_show",
    startsAt: "2027-01-04T13:00:00Z",
    endsAt: "2027-01-04T14:00:00Z",
    requestedAt: "2027-01-04T12:00:00Z",
    charge: 10_000,
  });
  await insertBooking({
    resource: "A2",
    member: "Yasmine",
    status: "completed",
    startsAt: "2027-01-05T08:30:00Z",
    endsAt: "2027-01-05T09:30:00Z",
    requestedAt: "2027-01-05T08:00:00Z",
  });
  const b4 = await insertBooking({
    resource: "R1",
    member: "Yasmine",
    status: "checked_in",
    startsAt: "2027-01-05T09:00:00Z",
    endsAt: "2027-01-05T11:00:00Z",
    requestedAt: "2027-01-04T09:00:00Z",
    charge: 40_000,
    checkedInAt: "2027-01-05T09:00:00Z",
  });
  const b5 = await insertBooking({
    resource: "A2",
    member: "Xavier",
    status: "cancelled",
    startsAt: "2027-01-04T09:00:00Z",
    endsAt: "2027-01-04T10:00:00Z",
    requestedAt: "2026-12-20T08:00:00Z",
    charge: 5_000,
    cancelledAt: "2027-01-04T08:00:00Z",
  });
  await insertBooking({
    resource: "A2",
    member: "Xavier",
    status: "cancelled",
    startsAt: "2027-01-04T11:00:00Z",
    endsAt: "2027-01-04T12:00:00Z",
    requestedAt: "2026-12-20T08:00:00Z",
    cancelledAt: "2027-01-01T08:00:00Z",
  });
  await insertBooking({
    resource: "A1",
    member: "Yasmine",
    status: "refused",
    startsAt: "2027-01-04T15:00:00Z",
    endsAt: "2027-01-04T16:00:00Z",
    requestedAt: "2027-01-03T08:00:00Z",
  });
  await insertBooking({
    resource: "A1",
    member: "Yasmine",
    status: "completed",
    startsAt: "2027-01-06T08:00:00Z",
    endsAt: "2027-01-06T10:00:00Z",
    requestedAt: "2027-01-03T08:00:00Z",
  });

  const monthly = await insertPlan("Mensuel", "month", 300_000);
  const yearly = await insertPlan("Annuel", "year", 1_200_000);
  const quarterly = await insertPlan("Trimestriel", "quarter", 100_000);
  const s1 = await insertSubscription(ids.Xavier!, monthly, 300_000, "2027-01-01", "2027-01-31");
  await insertSubscription(ids.Yasmine!, yearly, 1_200_000, "2026-06-01", "2027-05-31");
  await insertSubscription(ids.Yasmine!, quarterly, 100_000, "2027-01-01", "2027-03-31");
  await insertSubscription(ids.Xavier!, quarterly, 100_000, "2027-01-01", "2027-03-31", true);
  await insertSubscription(ids.Xavier!, monthly, 300_000, "2026-12-05", "2027-01-04");
  const product = await h.db
    .insertInto("cw_pack_products")
    .values({ centre_id: h.centreId, name: "10 heures", type_id: ids.hot, quota_kind: "minutes", quota: 600, validity_days: 90, price: 50_000 })
    .returning("id")
    .executeTakeFirstOrThrow();
  const pack = await h.db
    .insertInto("cw_packs")
    .values({
      centre_id: h.centreId,
      member_id: ids.Yasmine!,
      product_id: product.id,
      type_id: ids.hot,
      quota_kind: "minutes",
      quota: 600,
      price: 50_000,
      starts_on: "2027-01-05",
      expires_on: "2027-04-05",
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  const c1 = await insertCharge(ids.Xavier!, { cw_booking_id: b1 }, 20_000, "2027-01-04");
  const c2 = await insertCharge(ids.Xavier!, { cw_booking_id: b2 }, 10_000, "2027-01-04");
  const c4 = await insertCharge(ids.Yasmine!, { cw_booking_id: b4 }, 40_000, "2027-01-05");
  await insertCharge(ids.Xavier!, { cw_booking_id: b5 }, 5_000, "2027-01-04", "cancelled");
  await insertCharge(ids.Xavier!, { cw_subscription_id: s1 }, 300_000, "2027-01-04");
  const cPack = await insertCharge(ids.Yasmine!, { cw_pack_id: pack.id }, 50_000, "2027-01-05");
  await pay(ids.Xavier!, "2027-01-04T10:00:00Z", [
    { installmentId: c1, amount: 20_000 },
    { installmentId: c2, amount: 5_000 },
  ]);
  await pay(ids.Yasmine!, "2027-01-05T10:00:00Z", [{ installmentId: c4, amount: 40_000 }]);
  await pay(ids.Yasmine!, "2027-02-01T10:00:00Z", [{ installmentId: cPack, amount: 50_000 }]);

  await h.db
    .insertInto("audit_log")
    .values([
      { centre_id: h.centreId, user_id: null, action: "member.converted", object_type: "member", object_id: ids.Xavier!, at: "2027-01-04T10:00:00Z" },
      { centre_id: h.centreId, user_id: null, action: "member.converted", object_type: "member", object_id: ids.Yasmine!, at: "2026-12-01T10:00:00Z" },
    ])
    .execute();
});

afterAll(async () => {
  await h.close();
});

describe("coworking statistics", () => {
  it("measures occupancy against the open minutes minus closures", async () => {
    const res = await h.call("GET", `/api/coworking/stats/occupancy?${RANGE}`, accountant);
    expect(res.status).toBe(200);
    expect(res.body.openMinutes).toBe(900);
    expect(res.body.resources.map((r: Record<string, unknown>) => [r.code, r.bookedMinutes, r.usedMinutes, r.bookedRate, r.usedRate])).toEqual([
      ["A1", 180, 120, 2000, 1333],
      ["A2", 60, 0, 667, 0],
      ["R1", 120, 120, 1333, 1333],
    ]);
  });

  it("spreads booked minutes over weekdays and hours per type", async () => {
    const res = await h.call("GET", `/api/coworking/stats/heatmap?${RANGE}`, accountant);
    const hot = res.body.types.find((t: { typeId: string }) => t.typeId === ids.hot);
    expect(hot.resources).toBe(2);
    expect(hot.cells).toHaveLength(15);
    const cell = (weekday: number, hour: number) => hot.cells.find((c: { weekday: number; hour: number }) => c.weekday === weekday && c.hour === hour);
    expect(cell(1, 9)).toEqual({ weekday: 1, hour: 9, bookedMinutes: 60, capacityMinutes: 120, rate: 5000 });
    expect(cell(1, 10).bookedMinutes).toBe(60);
    expect(cell(1, 14).bookedMinutes).toBe(60);
    expect(cell(2, 9)).toEqual({ weekday: 2, hour: 9, bookedMinutes: 30, capacityMinutes: 120, rate: 2500 });
    expect(cell(2, 13)).toBeUndefined();
    expect(res.body.types.map((t: { typeName: string }) => t.typeName)).toEqual(["Open space", "Salle"]);
  });

  it("splits revenue issued and collected by source and type", async () => {
    const res = await h.call("GET", `/api/coworking/stats/revenue?${RANGE}`, accountant);
    expect(res.body.lines).toEqual([
      { source: "bookings", typeId: ids.hot, typeName: "Open space", issued: 30_000, collected: 25_000 },
      { source: "bookings", typeId: ids.meet, typeName: "Salle", issued: 40_000, collected: 40_000 },
      { source: "packs", typeId: ids.hot, typeName: "Open space", issued: 50_000, collected: 0 },
      { source: "subscriptions", typeId: null, typeName: null, issued: 300_000, collected: 0 },
    ]);
  });

  it("computes the headline indicators", async () => {
    const res = await h.call("GET", `/api/coworking/stats/indicators?${RANGE}`, accountant);
    expect(res.body).toEqual({
      bookings: 4,
      noShows: 1,
      noShowRate: 2500,
      lateCancellations: 1,
      lateCancellationRate: 1667,
      averageMinutes: 90,
      averageLeadMinutes: 743,
      activeSubscriptions: 3,
      monthlyRecurringRevenue: 433_333,
      convertedGuests: 1,
    });
  });

  it("ranks members by collected amount and validates the period", async () => {
    const res = await h.call("GET", `/api/coworking/stats/top-members?${RANGE}`, accountant);
    expect(res.body.items).toEqual([
      { memberId: ids.Yasmine, name: "Yasmine", company: null, collected: 40_000 },
      { memberId: ids.Xavier, name: "Xavier", company: null, collected: 25_000 },
    ]);
    expect((await h.call("GET", "/api/coworking/stats/indicators?from=2027-01-05&to=2027-01-04", accountant)).body.code).toBe("invalid_range");
    expect((await h.call("GET", "/api/coworking/stats/indicators?from=2026-01-01&to=2027-06-30", accountant)).body.code).toBe("period_too_long");
    const secretariat = await h.login("sec@stats.test");
    expect((await h.call("GET", `/api/coworking/stats/revenue?${RANGE}`, secretariat)).status).toBe(403);
  });
});
