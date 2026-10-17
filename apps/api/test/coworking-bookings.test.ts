import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cancelBooking,
  checkIn,
  createBooking,
  quoteBooking,
  releaseBooking,
  type BookingActor,
  type BookingInput,
  type MailContext,
} from "../src/domain/coworking/bookings.js";
import { floorState } from "../src/domain/coworking/availability.js";
import { sweepCoworking } from "../src/domain/coworking/sweeper.js";
import { createHarness, PUBLIC_ORIGIN, RecordingMailer, type Harness } from "./harness.js";

let h: Harness;
let admin: string;
let secretariat: string;
const mailer = new RecordingMailer();
const ids: Record<string, string> = {};
let mail: MailContext;

const at = (iso: string) => new Date(iso);
const portal = (memberId: string): BookingActor => ({ source: "portal", memberId });
const staff = (): BookingActor => ({ source: "staff", userId: ids.adminUser! });

async function insertMember(firstName: string, kind: "member" | "guest" = "member"): Promise<string> {
  const row = await h.db
    .insertInto("members")
    .values({
      centre_id: h.centreId,
      kind,
      first_name: firstName,
      last_name: "Test",
      email: kind === "member" ? `${firstName.toLowerCase()}@cw.test` : null,
      phone: "20 000 000",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertType(name: string, category: string, extra: Record<string, unknown> = {}): Promise<string> {
  const row = await h.db
    .insertInto("cw_resource_types")
    .values({ centre_id: h.centreId, name, category: category as "hot_desk", ...extra })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertResource(code: string, typeId: string, roomId: string | null = null): Promise<string> {
  const row = await h.db
    .insertInto("cw_resources")
    .values({ centre_id: h.centreId, type_id: typeId, floor_id: ids.floor!, code, room_id: roomId })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertFormat(
  typeId: string,
  label: string,
  values: Record<string, unknown>,
  prices: { profile: "visitor" | "member"; amount: number; offpeak?: number }[],
) {
  const row = await h.db
    .insertInto("cw_booking_formats")
    .values({ centre_id: h.centreId, type_id: typeId, label, nature: "fixed", ...values })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (prices.length)
    await h.db
      .insertInto("cw_prices")
      .values(prices.map((p) => ({ format_id: row.id, profile: p.profile, amount: p.amount, offpeak_amount: p.offpeak ?? null })))
      .execute();
  return row.id;
}

async function insertSubscription(memberId: string, startsOn: string, endsOn: string, entitlements: unknown[], assignedResourceId: string | null = null) {
  const plan = await h.db
    .insertInto("cw_plans")
    .values({ centre_id: h.centreId, name: `Plan ${memberId.slice(0, 6)}`, period: "month", price: 300_000, billing: "upfront" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const row = await h.db
    .insertInto("cw_subscriptions")
    .values({
      centre_id: h.centreId,
      member_id: memberId,
      plan_id: plan.id,
      starts_on: startsOn,
      ends_on: endsOn,
      price: 300_000,
      billing: "upfront",
      includes_domiciliation: false,
      entitlements: JSON.stringify(entitlements),
      assigned_resource_id: assignedResourceId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertPack(memberId: string, typeId: string, quota: number, startsOn: string, expiresOn: string): Promise<string> {
  const product = await h.db
    .insertInto("cw_pack_products")
    .values({ centre_id: h.centreId, name: `Pack ${quota} ${expiresOn}`, type_id: typeId, quota_kind: "minutes", quota, validity_days: 90, price: 50_000 })
    .returning("id")
    .executeTakeFirstOrThrow();
  const row = await h.db
    .insertInto("cw_packs")
    .values({
      centre_id: h.centreId,
      member_id: memberId,
      product_id: product.id,
      type_id: typeId,
      quota_kind: "minutes",
      quota,
      price: 50_000,
      starts_on: startsOn,
      expires_on: expiresOn,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function settings(values: Record<string, unknown>) {
  await h.db.updateTable("cw_settings").set(values).where("centre_id", "=", h.centreId).execute();
}

const input = (memberId: string, resourceId: string, formatId: string, date: string, startTime: string, extra: Partial<BookingInput> = {}): BookingInput => ({
  memberId,
  resourceId,
  formatId,
  date,
  startTime,
  ...extra,
});

const book = (memberId: string, resourceId: string, formatId: string, date: string, startTime: string, extra: Record<string, unknown> = {}) =>
  h.call("POST", "/api/coworking/bookings", secretariat, { memberId, resourceId, formatId, date, startTime, ...extra });

const quote = (memberId: string, resourceId: string, formatId: string, date: string, startTime: string, extra: Record<string, unknown> = {}) =>
  h.call("POST", "/api/coworking/bookings/quote", secretariat, { memberId, resourceId, formatId, date, startTime, ...extra });

const usageOf = (bookingId: string) =>
  h.db
    .selectFrom("cw_entitlement_usage")
    .select(["subscription_id", "pack_id", "quota_kind", "amount", "window_start", "status"])
    .where("booking_id", "=", bookingId)
    .orderBy("created_at")
    .execute();

const chargesOf = (bookingId: string) =>
  h.db
    .selectFrom("installments")
    .select(["id", "label", "amount", "due_date", "status"])
    .where("cw_booking_id", "=", bookingId)
    .orderBy("created_at")
    .execute();

beforeAll(async () => {
  h = await createHarness({ mailer });
  await h.setModules(["training", "coworking"]);
  ids.adminUser = await h.createUser("admin", "admin@cw.test");
  await h.createUser("secretariat", "sec@cw.test");
  await h.createUser("accountant", "compta@cw.test");
  admin = await h.login("admin@cw.test");
  secretariat = await h.login("sec@cw.test");
  mail = { mailer, log: h.app.log, publicOrigin: PUBLIC_ORIGIN };

  await h.db
    .updateTable("centres")
    .set({ open_from: "08:00", open_to: "20:00", open_weekdays: [1, 2, 3, 4, 5, 6, 7] })
    .where("id", "=", h.centreId)
    .execute();
  await h.db
    .insertInto("cw_settings")
    .values({
      centre_id: h.centreId,
      booking_horizon_days: 365,
      min_notice_minutes: 0,
      max_active_bookings: 100,
      approval_mode: "visitors",
      free_cancel_hours: 24,
      late_cancel_fee_bp: 5000,
      no_show_grace_minutes: 30,
      request_expiry_hours: 24,
      offpeak_from: "18:00",
    })
    .execute();
  ids.floor = (await h.db.insertInto("cw_floors").values({ centre_id: h.centreId, name: "Rez-de-chaussée" }).returning("id").executeTakeFirstOrThrow()).id;
  ids.room = (await h.db.insertInto("rooms").values({ centre_id: h.centreId, name: "Salle Atlas", capacity: 10 }).returning("id").executeTakeFirstOrThrow()).id;

  ids.hot = await insertType("Open space", "hot_desk");
  ids.meet = await insertType("Salle de réunion", "meeting_room", { buffer_minutes: 15 });
  ids.ded = await insertType("Bureau dédié", "dedicated_desk");
  ids.booth = await insertType("Cabine", "phone_booth", { requires_approval: true });
  ids.A1 = await insertResource("A1", ids.hot);
  ids.A2 = await insertResource("A2", ids.hot);
  ids.A3 = await insertResource("A3", ids.hot);
  ids.A4 = await insertResource("A4", ids.hot);
  ids.R1 = await insertResource("R1", ids.meet, ids.room);
  ids.D1 = await insertResource("D1", ids.ded);
  ids.B1 = await insertResource("B1", ids.booth);

  ids.fHour = await insertFormat(ids.hot, "Heure", { duration_minutes: 60, start_step_minutes: 60 }, [
    { profile: "visitor", amount: 10_000, offpeak: 6_000 },
    { profile: "member", amount: 8_000 },
  ]);
  ids.fMorning = await insertFormat(ids.hot, "Matinée", { nature: "named", start_time: "08:00", end_time: "12:00" }, [{ profile: "visitor", amount: 30_000 }]);
  ids.fWeekend = await insertFormat(ids.hot, "Week-end", { duration_minutes: 120, start_step_minutes: 60, weekdays: [6, 7] }, []);
  ids.fFree = await insertFormat(ids.meet, "Libre", { nature: "free", min_minutes: 30, max_minutes: 240, start_step_minutes: 30 }, [
    { profile: "visitor", amount: 40_000 },
    { profile: "member", amount: 30_000 },
  ]);
  ids.fBooth = await insertFormat(ids.booth, "Demi-heure", { duration_minutes: 30, start_step_minutes: 30 }, [{ profile: "visitor", amount: 5_000 }]);

  ids.V = await insertMember("Vera");
  ids.M = await insertMember("Mehdi");
  ids.G = await insertMember("Ghassen", "guest");
  ids.P = await insertMember("Pauline");
  ids.W = await insertMember("Walid");
  ids.M2 = await insertMember("Mouna");
  ids.subM = await insertSubscription(ids.M, "2027-01-15", "2027-12-14", [
    { typeId: ids.hot, quotaKind: "minutes", quota: 120 },
    { typeId: ids.meet, quotaKind: "bookings", quota: 1 },
  ]);
  ids.pack1 = await insertPack(ids.P, ids.hot, 60, "2027-01-01", "2027-06-30");
  ids.pack2 = await insertPack(ids.P, ids.hot, 120, "2027-01-01", "2027-03-31");

  await h.db
    .insertInto("cw_promo_codes")
    .values([
      { centre_id: h.centreId, code: "PCT10", kind: "percent", value: 1000, valid_from: "2026-01-01", valid_to: "2027-12-31", max_uses: 2 },
      { centre_id: h.centreId, code: "AMT3", kind: "amount", value: 3_000, valid_from: "2026-01-01", valid_to: "2027-12-31" },
      { centre_id: h.centreId, code: "AMT20", kind: "amount", value: 20_000, valid_from: "2026-01-01", valid_to: "2027-12-31" },
      { centre_id: h.centreId, code: "MEMONLY", kind: "percent", value: 5000, valid_from: "2026-01-01", valid_to: "2027-12-31", profiles: ["member"] },
      { centre_id: h.centreId, code: "OLD", kind: "percent", value: 5000, valid_from: "2026-01-01", valid_to: "2026-01-31" },
    ])
    .execute();
});

afterAll(async () => {
  await h.close();
});

describe("slots and opening hours", () => {
  it("generates fixed, named and free slots inside the opening", async () => {
    const fixed = await h.call("GET", `/api/coworking/formats/${ids.fHour}/slots?date=2027-02-01`, secretariat);
    expect(fixed.status).toBe(200);
    expect(fixed.body.open).toEqual({ from: "08:00", to: "20:00" });
    expect(fixed.body.slots).toHaveLength(12);
    expect(fixed.body.slots[0]).toMatchObject({ startTime: "08:00", endTime: "09:00", minutes: 60, free: 4, startsAt: "2027-02-01T07:00:00.000Z" });
    const named = await h.call("GET", `/api/coworking/formats/${ids.fMorning}/slots?date=2027-02-01`, secretariat);
    expect(named.body.slots.map((s: { startTime: string; endTime: string }) => `${s.startTime}-${s.endTime}`)).toEqual(["08:00-12:00"]);
    const free = await h.call("GET", `/api/coworking/formats/${ids.fFree}/slots?date=2027-02-01&durationMinutes=90`, secretariat);
    expect(free.body.slots).toHaveLength(22);
    expect(free.body.slots.at(-1)).toMatchObject({ startTime: "18:30", endTime: "20:00", free: 1 });
    const badLength = await h.call("GET", `/api/coworking/formats/${ids.fFree}/slots?date=2027-02-01&durationMinutes=45`, secretariat);
    expect(badLength.status).toBe(422);
    expect(badLength.body.code).toBe("invalid_duration");
    const weekday = await h.call("GET", `/api/coworking/formats/${ids.fWeekend}/slots?date=2027-02-01`, secretariat);
    expect(weekday.body.slots).toEqual([]);
    const saturday = await h.call("GET", `/api/coworking/formats/${ids.fWeekend}/slots?date=2027-02-06`, secretariat);
    expect(saturday.body.slots).toHaveLength(11);
  });

  it("applies closed days and reduced hours", async () => {
    await h.db
      .insertInto("cw_closures")
      .values([
        { centre_id: h.centreId, starts_on: "2027-01-10", ends_on: "2027-01-11", label: "Fermeture" },
        { centre_id: h.centreId, starts_on: "2027-01-12", ends_on: "2027-01-12", label: "Inventaire", open_from: "10:00", open_to: "14:00" },
      ])
      .execute();
    const closed = await h.call("GET", `/api/coworking/formats/${ids.fHour}/slots?date=2027-01-11`, secretariat);
    expect(closed.body.open).toBeNull();
    expect(closed.body.closures).toEqual(["Fermeture"]);
    expect(closed.body.slots).toEqual([]);
    const reduced = await h.call("GET", `/api/coworking/formats/${ids.fHour}/slots?date=2027-01-12`, secretariat);
    expect(reduced.body.open).toEqual({ from: "10:00", to: "14:00" });
    expect(reduced.body.slots.map((s: { startTime: string }) => s.startTime)).toEqual(["10:00", "11:00", "12:00", "13:00"]);
    expect((await h.call("GET", `/api/coworking/formats/${ids.fMorning}/slots?date=2027-01-12`, secretariat)).body.slots).toEqual([]);
    const refused = await quote(ids.V, ids.A1, ids.fHour, "2027-01-11", "09:00");
    expect(refused.body.code).toBe("centre_closed");
    const outside = await quote(ids.V, ids.A1, ids.fHour, "2027-01-12", "09:00");
    expect(outside.body.code).toBe("invalid_slot");
  });
});

describe("prices", () => {
  it("prices visitors, members, the member fallback, off-peak and free formats", async () => {
    const visitor = await quote(ids.V, ids.A1, ids.fHour, "2027-02-01", "09:00");
    expect(visitor.status).toBe(200);
    expect(visitor.body).toMatchObject({ profile: "visitor", listPrice: 10_000, offpeak: false, charge: 10_000, status: "confirmed", warnings: [] });
    expect((await quote(ids.V, ids.A1, ids.fHour, "2027-02-01", "18:00")).body).toMatchObject({ listPrice: 6_000, offpeak: true });
    expect((await quote(ids.G, ids.A1, ids.fHour, "2027-02-01", "09:00")).body.profile).toBe("visitor");
    const member = await quote(ids.M, ids.A1, ids.fHour, "2027-02-01", "09:00");
    expect(member.body).toMatchObject({ profile: "member", listPrice: 8_000 });
    // The member price has no off-peak amount: the normal member price applies after 18:00.
    expect((await quote(ids.M, ids.A1, ids.fHour, "2027-02-01", "18:00")).body).toMatchObject({ listPrice: 8_000, offpeak: false });
    // No member price for the morning: the visitor price applies.
    expect((await quote(ids.M, ids.A1, ids.fMorning, "2027-02-01", "08:00")).body.listPrice).toBe(30_000);
    const free = await quote(ids.V, ids.R1, ids.fFree, "2027-02-01", "10:00", { durationMinutes: 90 });
    expect(free.body).toMatchObject({ listPrice: 60_000, minutes: 90, endTime: "11:30" });
    expect(new Date(free.body.blockedUntil).toISOString()).toBe("2027-02-01T10:45:00.000Z");
    const notForSale = await quote(ids.V, ids.A1, ids.fWeekend, "2027-02-06", "09:00");
    expect(notForSale.status).toBe(422);
    expect(notForSale.body.code).toBe("no_price");
    const wrongType = await quote(ids.V, ids.R1, ids.fHour, "2027-02-01", "09:00");
    expect(wrongType.body.code).toBe("format_mismatch");
    const assigned = await quote(ids.V, ids.D1, ids.fHour, "2027-02-01", "09:00");
    expect(assigned.body.code).toBe("resource_not_bookable");
  });

  it("applies percent and amount promotions with their limits", async () => {
    expect((await quote(ids.V, ids.A1, ids.fHour, "2027-02-01", "09:00", { promoCode: "pct10" })).body).toMatchObject({
      promotion: { code: "PCT10", discount: 1_000 },
      charge: 9_000,
    });
    expect((await quote(ids.V, ids.A1, ids.fHour, "2027-02-01", "09:00", { promoCode: "AMT3" })).body.charge).toBe(7_000);
    expect((await quote(ids.V, ids.A1, ids.fHour, "2027-02-01", "09:00", { promoCode: "AMT20" })).body).toMatchObject({
      promotion: { discount: 10_000 },
      charge: 0,
    });
    expect((await quote(ids.V, ids.A1, ids.fHour, "2027-02-01", "09:00", { promoCode: "MEMONLY" })).body.code).toBe("promo_not_applicable");
    expect((await quote(ids.V, ids.A1, ids.fHour, "2027-02-01", "09:00", { promoCode: "OLD" })).body.code).toBe("promo_expired");
    expect((await quote(ids.V, ids.A1, ids.fHour, "2027-02-01", "09:00", { promoCode: "NOPE" })).body.code).toBe("promo_unknown");

    const first = await book(ids.V, ids.A1, ids.fHour, "2027-02-08", "09:00", { promoCode: "PCT10" });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ promoDiscount: 1_000, charge: 9_000, status: "confirmed" });
    expect(await chargesOf(first.body.id)).toEqual([
      expect.objectContaining({ label: "Coworking : Poste flexible A1, 08/02/2027 09:00-10:00", amount: 9_000, due_date: "2027-02-08", status: "open" }),
    ]);
    expect((await book(ids.V, ids.A1, ids.fHour, "2027-02-08", "10:00", { promoCode: "PCT10" })).status).toBe(201);
    const third = await quote(ids.V, ids.A1, ids.fHour, "2027-02-08", "11:00", { promoCode: "PCT10" });
    expect(third.body.code).toBe("promo_exhausted");
    await h.call("POST", `/api/coworking/bookings/${first.body.id}/cancel`, secretariat, { reason: "erreur de saisie" });
    expect((await quote(ids.V, ids.A1, ids.fHour, "2027-02-08", "11:00", { promoCode: "PCT10" })).status).toBe(200);
  });
});

describe("entitlements", () => {
  it("uses the subscription minutes and bookings quotas per subscription month", async () => {
    const first = await book(ids.M, ids.A1, ids.fHour, "2027-02-01", "09:00");
    expect(first.body).toMatchObject({ profile: "member", listPrice: 8_000, coveredMinutes: 60, coverageDiscount: 8_000, charge: 0 });
    expect(await usageOf(first.body.id)).toEqual([
      { subscription_id: ids.subM, pack_id: null, quota_kind: "minutes", amount: 60, window_start: "2027-01-15", status: "active" },
    ]);
    expect(await chargesOf(first.body.id)).toEqual([]);

    const second = await book(ids.M, ids.A1, ids.fHour, "2027-02-05", "10:00");
    expect(second.body.coveredMinutes).toBe(60);
    const third = await book(ids.M, ids.A1, ids.fHour, "2027-02-05", "11:00");
    expect(third.body).toMatchObject({ coveredMinutes: 0, charge: 8_000 });

    // A new subscription month starts on the 15th.
    const nextWindow = await book(ids.M, ids.A1, ids.fHour, "2027-02-20", "09:00");
    expect(nextWindow.body.coveredMinutes).toBe(60);
    expect((await usageOf(nextWindow.body.id))[0]!.window_start).toBe("2027-02-15");
    const partial = await book(ids.M, ids.A2, ids.fMorning, "2027-02-21", "08:00");
    expect(partial.body).toMatchObject({ listPrice: 30_000, coveredMinutes: 60, coverageDiscount: 7_500, charge: 22_500 });

    const meeting = await book(ids.M, ids.R1, ids.fFree, "2027-02-02", "10:00", { durationMinutes: 90 });
    expect(meeting.body).toMatchObject({ listPrice: 45_000, coveredMinutes: 90, charge: 0 });
    expect(await usageOf(meeting.body.id)).toEqual([expect.objectContaining({ quota_kind: "bookings", amount: 1 })]);
    const meeting2 = await book(ids.M, ids.R1, ids.fFree, "2027-02-03", "10:00", { durationMinutes: 60 });
    expect(meeting2.body).toMatchObject({ listPrice: 30_000, coveredMinutes: 0, charge: 30_000 });
  });

  it("consumes packs by earliest expiry", async () => {
    const first = await book(ids.P, ids.A1, ids.fHour, "2027-03-01", "09:00");
    expect(first.body).toMatchObject({ profile: "visitor", coveredMinutes: 60, charge: 0 });
    expect(await usageOf(first.body.id)).toEqual([expect.objectContaining({ pack_id: ids.pack2, amount: 60 })]);
    const morning = await book(ids.P, ids.A1, ids.fMorning, "2027-03-02", "08:00");
    expect(morning.body).toMatchObject({ coveredMinutes: 120, coverageDiscount: 15_000, charge: 15_000 });
    expect((await usageOf(morning.body.id)).map((u) => [u.pack_id, u.amount])).toEqual([
      [ids.pack2, 60],
      [ids.pack1, 60],
    ]);
  });
});

describe("approval and portal limits", () => {
  it("gives the status of portal bookings from the approval mode", async () => {
    const visitor = await createBooking(h.db, h.centreId, portal(ids.V), input(ids.V, ids.A3, ids.fHour, "2027-03-03", "09:00"));
    expect(visitor.booking.status).toBe("requested");
    expect(await chargesOf(visitor.booking.id)).toEqual([]);
    const member = await createBooking(h.db, h.centreId, portal(ids.M), input(ids.M, ids.A3, ids.fHour, "2027-03-03", "10:00"));
    expect(member.booking.status).toBe("confirmed");
    const approvalType = await quoteBooking(h.db, h.centreId, portal(ids.M), input(ids.M, ids.B1, ids.fBooth, "2027-03-03", "10:00"));
    expect(approvalType.status).toBe("requested");
    await settings({ approval_mode: "all" });
    expect((await quoteBooking(h.db, h.centreId, portal(ids.M), input(ids.M, ids.A3, ids.fHour, "2027-03-03", "11:00"))).status).toBe("requested");
    await settings({ approval_mode: "none" });
    expect((await quoteBooking(h.db, h.centreId, portal(ids.V), input(ids.V, ids.A3, ids.fHour, "2027-03-03", "11:00"))).status).toBe("confirmed");
    await settings({ approval_mode: "visitors" });
    // Staff bookings are always confirmed.
    expect((await quoteBooking(h.db, h.centreId, staff(), input(ids.V, ids.B1, ids.fBooth, "2027-03-03", "10:00"))).status).toBe("confirmed");
    await expect(createBooking(h.db, h.centreId, portal(ids.V), input(ids.M, ids.A3, ids.fHour, "2027-03-03", "12:00"))).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("enforces portal limits and lets the staff override them", async () => {
    await settings({ booking_horizon_days: 30, min_notice_minutes: 120, max_active_bookings: 3 });
    await h.db.updateTable("cw_resource_types").set({ max_minutes_per_day: 120 }).where("id", "=", ids.hot).execute();
    const now = at("2027-04-01T06:00:00Z");
    const fresh = await insertMember("Farah");
    await expect(createBooking(h.db, h.centreId, portal(fresh), input(fresh, ids.A4, ids.fHour, "2027-05-10", "09:00"), now)).rejects.toMatchObject({
      code: "beyond_horizon",
    });
    await expect(createBooking(h.db, h.centreId, portal(fresh), input(fresh, ids.A4, ids.fHour, "2027-04-01", "08:00"), now)).rejects.toMatchObject({
      code: "notice_too_short",
    });
    for (const date of ["2027-04-02", "2027-04-03", "2027-04-04"]) {
      await createBooking(h.db, h.centreId, portal(fresh), input(fresh, ids.A4, ids.fHour, date, "09:00"), now);
    }
    await expect(createBooking(h.db, h.centreId, portal(fresh), input(fresh, ids.A4, ids.fHour, "2027-04-05", "09:00"), now)).rejects.toMatchObject({
      code: "too_many_active_bookings",
    });
    const daily = await insertMember("Dora");
    await createBooking(h.db, h.centreId, portal(daily), input(daily, ids.A4, ids.fHour, "2027-04-06", "09:00"), now);
    await createBooking(h.db, h.centreId, portal(daily), input(daily, ids.A4, ids.fHour, "2027-04-06", "10:00"), now);
    await expect(createBooking(h.db, h.centreId, portal(daily), input(daily, ids.A4, ids.fHour, "2027-04-06", "11:00"), now)).rejects.toMatchObject({
      code: "daily_limit_exceeded",
    });

    const staffQuote = await quoteBooking(h.db, h.centreId, staff(), input(fresh, ids.A4, ids.fHour, "2027-05-10", "09:00"), now);
    expect(staffQuote.warnings.map((w) => w.code)).toEqual(["beyond_horizon", "too_many_active_bookings"]);
    await expect(createBooking(h.db, h.centreId, staff(), input(fresh, ids.A4, ids.fHour, "2027-05-10", "09:00"), now)).rejects.toMatchObject({
      code: "limits_exceeded",
    });
    const overridden = await createBooking(h.db, h.centreId, staff(), input(fresh, ids.A4, ids.fHour, "2027-05-10", "09:00", { override: true }), now);
    expect(overridden.overridden).toEqual(["beyond_horizon", "too_many_active_bookings"]);
    const audit = await h.db.selectFrom("audit_log").select(["reason", "after"]).where("object_id", "=", overridden.booking.id).executeTakeFirstOrThrow();
    expect(audit.reason).toContain("beyond_horizon");
    expect(audit.after).toMatchObject({ overriddenLimits: ["beyond_horizon", "too_many_active_bookings"] });

    await settings({ booking_horizon_days: 365, min_notice_minutes: 0, max_active_bookings: 100 });
    await h.db.updateTable("cw_resource_types").set({ max_minutes_per_day: null }).where("id", "=", ids.hot).execute();
  });
});

describe("conflicts", () => {
  it("lets only one of two concurrent bookings take a slot", async () => {
    const results = await Promise.allSettled([
      createBooking(h.db, h.centreId, staff(), input(ids.V, ids.A2, ids.fHour, "2027-03-04", "09:00")),
      createBooking(h.db, h.centreId, staff(), input(ids.W, ids.A2, ids.fHour, "2027-03-04", "09:00")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { statusCode: 409, code: "slot_taken" } });
    const http = await book(ids.W, ids.A2, ids.fHour, "2027-03-04", "09:00");
    expect(http.status).toBe(409);
    expect(http.body.code).toBe("slot_taken");
  });

  it("refuses a meeting room shared with a training session and books the room otherwise", async () => {
    const subject = (await h.call("POST", "/api/catalogue/subjects", admin, { name: "Gestion" })).body.id;
    const teacher = (
      await h.call("POST", "/api/instructors", admin, {
        firstName: "Sami",
        lastName: "Ben",
        kind: "trainer",
        employment: "freelance",
        subjectIds: [],
        availability: [],
      })
    ).body.id;
    const study = (
      await h.call("POST", "/api/catalogue/studies", admin, {
        subjectId: subject,
        name: "Gestion 1",
        billingMode: "monthly",
        price: 35_000,
        absenceBilled: true,
        sessionsPerWeek: 1,
        capacity: 10,
      })
    ).body.id;
    const group = (
      await h.call("POST", "/api/groups", admin, {
        kind: "study",
        studyId: study,
        name: "Groupe Atlas",
        instructorId: teacher,
        roomId: ids.room,
        startDate: "2027-01-01",
        endDate: "2027-06-30",
        slots: [{ weekday: 1, startTime: "14:00", endTime: "16:00" }],
      })
    ).body.id;
    await h.call("POST", `/api/groups/${group}/sessions/generate`, admin, { from: "2027-03-01", to: "2027-03-31" });
    const clash = await book(ids.V, ids.R1, ids.fFree, "2027-03-08", "15:00", { durationMinutes: 60 });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("room_unavailable");
    // The 15 minutes of buffer also keep the room: 13:00-13:45 is free, 13:00-14:00 plus buffer is not.
    expect((await book(ids.V, ids.R1, ids.fFree, "2027-03-08", "13:00", { durationMinutes: 60 })).body.code).toBe("room_unavailable");
    const ok = await book(ids.V, ids.R1, ids.fFree, "2027-03-08", "10:00", { durationMinutes: 60 });
    expect(ok.status).toBe(201);
    const room = await h.db
      .selectFrom("room_bookings")
      .select(["active", sql<string>`upper(period)`.as("until")])
      .where("cw_booking_id", "=", ok.body.id)
      .executeTakeFirstOrThrow();
    expect(room.active).toBe(true);
    expect(new Date(room.until).toISOString()).toBe("2027-03-08T10:15:00.000Z");
    await h.call("POST", `/api/coworking/bookings/${ok.body.id}/cancel`, secretariat, { reason: "réunion déplacée" });
    expect((await h.db.selectFrom("room_bookings").select("active").where("cw_booking_id", "=", ok.body.id).executeTakeFirstOrThrow()).active).toBe(false);
  });
});

describe("decisions and cancellations", () => {
  it("refuses a request, gives back the pack and e-mails the reason", async () => {
    const pack = await insertPack(ids.P, ids.hot, 600, "2027-03-01", "2027-03-31");
    const created = await createBooking(h.db, h.centreId, portal(ids.P), input(ids.P, ids.A3, ids.fHour, "2027-03-10", "09:00"));
    expect(created.booking.status).toBe("requested");
    expect(await usageOf(created.booking.id)).toEqual([expect.objectContaining({ status: "active" })]);
    const queue = await h.call("GET", "/api/coworking/requests", secretariat);
    expect(queue.body.items.map((i: { id: string }) => i.id)).toContain(created.booking.id);
    const sent = mailer.sent.length;
    const refused = await h.call("POST", `/api/coworking/bookings/${created.booking.id}/refuse`, secretariat, { reason: "Espace réservé pour un événement" });
    expect(refused.status).toBe(200);
    expect(refused.body).toMatchObject({ status: "refused", refusalReason: "Espace réservé pour un événement" });
    expect((await usageOf(created.booking.id)).map((u) => u.status)).toEqual(["released"]);
    expect(mailer.sent.length).toBe(sent + 1);
    expect(mailer.sent.at(-1)).toMatchObject({ to: "pauline@cw.test", subject: "Réservation refusée" });
    expect(mailer.sent.at(-1)!.text).toContain("motif : Espace réservé pour un événement");
    expect((await h.call("POST", `/api/coworking/bookings/${created.booking.id}/approve`, secretariat)).body.code).toBe("already_decided");
    await h.db.deleteFrom("cw_entitlement_usage").where("pack_id", "=", pack).execute();
    await h.db.deleteFrom("cw_packs").where("id", "=", pack).execute();
  });

  it("approves a request, creates its charge and e-mails the member", async () => {
    const created = await createBooking(h.db, h.centreId, portal(ids.V), input(ids.V, ids.A3, ids.fHour, "2027-03-11", "09:00"));
    expect(await chargesOf(created.booking.id)).toEqual([]);
    const approved = await h.call("POST", `/api/coworking/bookings/${created.booking.id}/approve`, secretariat);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("confirmed");
    expect(await chargesOf(created.booking.id)).toEqual([
      expect.objectContaining({ label: "Coworking : Poste flexible A3, 11/03/2027 09:00-10:00", amount: 10_000, due_date: "2027-03-11" }),
    ]);
    const message = mailer.sent.at(-1)!;
    expect(message).toMatchObject({ to: "vera@cw.test", subject: "Réservation confirmée" });
    expect(message.text).toContain("le 11/03/2027 de 09:00 à 10:00");
    expect(message.text).toContain("Poste flexible A3");
    expect(message.text).toContain("à régler à l'accueil");
    expect(message.text).toContain(`${PUBLIC_ORIGIN}/espace/reservations`);
    const detail = await h.call("GET", `/api/coworking/bookings/${created.booking.id}`, secretariat);
    expect(detail.body).toMatchObject({ status: "confirmed", due: 10_000, paid: 0 });
    expect(detail.body.charges).toHaveLength(1);
  });

  it("cancels in time for free and late with a fee", async () => {
    const free = await book(ids.P, ids.A4, ids.fMorning, "2027-03-15", "08:00");
    expect(free.body.charge).toBeGreaterThan(0);
    const cancelled = await h.call("POST", `/api/coworking/bookings/${free.body.id}/cancel`, secretariat, { reason: "changement de programme" });
    expect(cancelled.body).toMatchObject({ status: "cancelled", free: true, fee: 0 });
    expect((await chargesOf(free.body.id)).map((c) => c.status)).toEqual(["cancelled"]);
    expect((await usageOf(free.body.id)).every((u) => u.status === "released")).toBe(true);
    expect(mailer.sent.at(-1)!.subject).toBe("Réservation annulée");

    const late = await book(ids.M, ids.A4, ids.fMorning, "2027-03-17", "08:00");
    expect(late.body).toMatchObject({ coveredMinutes: 120, charge: 15_000 });
    const result = await cancelBooking(h.db, mail, h.centreId, portal(ids.M), late.body.id, "empêchement", at("2027-03-17T06:00:00Z"));
    expect(result).toMatchObject({ free: false, fee: 7_500 });
    expect(result.booking.lateCancelFee).toBe(7_500);
    const charges = await chargesOf(late.body.id);
    expect(charges.map((c) => [c.amount, c.status, c.due_date])).toEqual([
      [15_000, "cancelled", "2027-03-17"],
      [7_500, "open", "2027-03-17"],
    ]);
    expect(charges[1]!.label).toBe("Coworking : frais d'annulation tardive, Poste flexible A4, 17/03/2027 08:00-12:00");
    expect((await usageOf(late.body.id)).map((u) => u.status)).toEqual(["active"]);
    await expect(cancelBooking(h.db, mail, h.centreId, portal(ids.V), late.body.id, "x")).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses to cancel a booking whose charge was paid", async () => {
    const payer = await insertMember("Karim");
    const booking = await book(payer, ids.A4, ids.fHour, "2027-03-18", "09:00");
    const payment = await h.call("POST", "/api/payments", secretariat, { memberId: payer, amount: 10_000, method: "cash" });
    expect(payment.status).toBe(201);
    const refused = await h.call("POST", `/api/coworking/bookings/${booking.body.id}/cancel`, secretariat, { reason: "annulation" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("installment_paid");
    expect((await h.call("GET", `/api/coworking/bookings/${booking.body.id}`, secretariat)).body).toMatchObject({ status: "confirmed", paid: 10_000, due: 0 });
  });
});

describe("check-in and release", () => {
  it("checks in within the window by code and releases a running booking", async () => {
    const booking = await book(ids.W, ids.A4, ids.fHour, "2027-03-22", "09:00");
    const code = booking.body.checkInCode as string;
    expect((await h.call("GET", `/api/coworking/check-in/${code}`, secretariat)).body).toMatchObject({ id: booking.body.id, status: "confirmed" });
    expect((await h.call("GET", "/api/coworking/check-in/unknowncode", secretariat)).status).toBe(404);
    await expect(checkIn(h.db, h.centreId, { code }, { source: "qr", userId: null }, at("2027-03-22T07:29:00Z"))).rejects.toMatchObject({
      code: "check_in_closed",
    });
    expect((await h.call("POST", "/api/coworking/check-in", secretariat, { code })).body.code).toBe("check_in_closed");
    const checked = await checkIn(h.db, h.centreId, { code }, { source: "qr", userId: null }, at("2027-03-22T07:30:00Z"));
    expect(checked.status).toBe("checked_in");
    await expect(
      checkIn(h.db, h.centreId, { bookingId: booking.body.id }, { source: "staff", userId: ids.adminUser! }, at("2027-03-22T07:40:00Z")),
    ).rejects.toMatchObject({
      code: "already_checked_in",
    });
    const events = await h.db.selectFrom("cw_access_events").select(["source", "member_id"]).where("booking_id", "=", booking.body.id).execute();
    expect(events).toEqual([{ source: "qr", member_id: ids.W }]);
    const released = await releaseBooking(h.db, h.centreId, ids.adminUser!, booking.body.id, at("2027-03-22T08:20:00Z"));
    expect(released).toMatchObject({ status: "completed", endTime: "09:20" });
    expect(released.blockedUntil.toISOString()).toBe("2027-03-22T08:20:00.000Z");
    expect((await chargesOf(booking.body.id)).map((c) => [c.amount, c.status])).toEqual([[10_000, "open"]]);
  });

  it("shortens the shared room on release", async () => {
    const booking = await book(ids.V, ids.R1, ids.fFree, "2027-03-23", "10:00", { durationMinutes: 60 });
    await checkIn(h.db, h.centreId, { bookingId: booking.body.id }, { source: "staff", userId: ids.adminUser! }, at("2027-03-23T09:00:00Z"));
    await releaseBooking(h.db, h.centreId, ids.adminUser!, booking.body.id, at("2027-03-23T09:30:00Z"));
    const room = await h.db
      .selectFrom("room_bookings")
      .select(sql<string>`upper(period)`.as("until"))
      .where("cw_booking_id", "=", booking.body.id)
      .executeTakeFirstOrThrow();
    expect(new Date(room.until).toISOString()).toBe("2027-03-23T09:30:00.000Z");
  });
});

describe("plan, blocks and reassignment", () => {
  it("draws the state of every resource of a floor", async () => {
    const dedicated = await insertMember("Dalia");
    await insertSubscription(dedicated, "2027-04-01", "2027-04-30", [], ids.D1);
    const occupied = await book(ids.W, ids.A1, ids.fHour, "2027-04-20", "09:00");
    await checkIn(h.db, h.centreId, { bookingId: occupied.body.id }, { source: "staff", userId: ids.adminUser! }, at("2027-04-20T08:00:00Z"));
    await book(ids.V, ids.A2, ids.fHour, "2027-04-20", "09:00");
    await createBooking(h.db, h.centreId, portal(ids.P), input(ids.P, ids.A3, ids.fHour, "2027-04-20", "09:00"), at("2027-04-19T08:00:00Z"));
    await h.db.updateTable("cw_resources").set({ status: "out_of_service", out_of_service_reason: "Écran cassé" }).where("id", "=", ids.B1).execute();
    const block = await h.call("POST", "/api/coworking/blocks", secretariat, {
      resourceId: ids.R1,
      startDate: "2027-04-20",
      startTime: "08:00",
      endDate: "2027-04-20",
      endTime: "12:00",
      reason: "Maintenance climatisation",
    });
    expect(block.status).toBe(201);

    const live = await h.call("GET", `/api/coworking/floors/${ids.floor}/state?at=2027-04-20T08:30:00Z`, secretariat);
    expect(live.status).toBe(200);
    const states = Object.fromEntries(live.body.resources.map((r: { code: string; state: string }) => [r.code, r.state]));
    expect(states).toEqual({ A1: "occupied", A2: "booked", A3: "requested", A4: "free", B1: "blocked", D1: "assigned", R1: "blocked" });
    const a1 = live.body.resources.find((r: { code: string }) => r.code === "A1");
    expect(a1.occupant).toMatchObject({ memberName: "Walid Test", phone: "20 000 000", charge: 10_000, paid: 0, status: "checked_in" });
    expect(live.body.resources.find((r: { code: string }) => r.code === "D1").subscriber.memberName).toBe("Dalia Test");
    expect(live.body.resources.find((r: { code: string }) => r.code === "R1").occupant).toMatchObject({ kind: "block", notes: "Maintenance climatisation" });

    const publicView = await floorState(h.db, h.centreId, ids.floor!, { at: at("2027-04-20T08:30:00Z"), date: "2027-04-20" }, "portal");
    expect(publicView.resources.every((r) => r.occupant === undefined && r.subscriber === undefined)).toBe(true);
    const later = await h.call("GET", `/api/coworking/floors/${ids.floor}/state?date=2027-04-20&startTime=12:00&endTime=13:00`, secretariat);
    expect(later.body.resources.filter((r: { state: string }) => r.state === "free").map((r: { code: string }) => r.code)).toEqual([
      "A1",
      "A2",
      "A3",
      "A4",
      "R1",
    ]);

    const planning = await h.call("GET", "/api/coworking/planning?date=2027-04-20", secretariat);
    const floor = planning.body.floors.find((f: { id: string }) => f.id === ids.floor);
    expect(floor.resources.find((r: { code: string }) => r.code === "A1").bookings).toHaveLength(1);
    await h.db.updateTable("cw_resources").set({ status: "active", out_of_service_reason: null }).where("id", "=", ids.B1).execute();

    expect((await book(ids.V, ids.R1, ids.fFree, "2027-04-20", "10:00", { durationMinutes: 60 })).body.code).toBe("slot_taken");
    expect((await h.call("DELETE", `/api/coworking/blocks/${block.body.id}`, secretariat)).status).toBe(204);
    expect((await book(ids.V, ids.R1, ids.fFree, "2027-04-20", "10:00", { durationMinutes: 60 })).status).toBe(201);
    expect((await h.call("DELETE", `/api/coworking/blocks/${block.body.id}`, secretariat)).body.code).toBe("not_cancellable");
  });

  it("moves a booking to another free resource of the same type and keeps its price", async () => {
    const booking = await book(ids.V, ids.A2, ids.fHour, "2027-04-21", "09:00", { promoCode: "AMT3" });
    await book(ids.W, ids.A1, ids.fHour, "2027-04-21", "09:00");
    const alternatives = await h.call("GET", `/api/coworking/bookings/${booking.body.id}/alternatives`, secretariat);
    expect(alternatives.body.items.map((r: { code: string }) => r.code)).toEqual(["A3", "A4"]);
    const moved = await h.call("POST", `/api/coworking/bookings/${booking.body.id}/reassign`, secretariat, { resourceId: ids.A3 });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ resourceCode: "A3", charge: 7_000, listPrice: 10_000 });
    const taken = await h.call("POST", `/api/coworking/bookings/${booking.body.id}/reassign`, secretariat, { resourceId: ids.A1 });
    expect(taken.body.code).toBe("slot_taken");
    const otherType = await h.call("POST", `/api/coworking/bookings/${booking.body.id}/reassign`, secretariat, { resourceId: ids.R1 });
    expect(otherType.body.code).toBe("invalid_resource");
  });

  it("lists bookings with filters and checks permissions", async () => {
    const list = await h.call("GET", `/api/coworking/bookings?memberId=${ids.W}&from=2027-04-01&to=2027-04-30`, secretariat);
    expect(list.status).toBe(200);
    expect(list.body.items.map((b: { resourceCode: string }) => b.resourceCode).sort()).toEqual(["A1", "A1"]);
    const accountant = await h.login("compta@cw.test");
    expect((await h.call("GET", "/api/coworking/bookings", accountant)).status).toBe(200);
    expect((await h.call("POST", "/api/coworking/bookings/quote", accountant, {})).status).toBe(403);
    expect((await h.call("GET", "/api/coworking/stats/indicators?from=2027-01-01&to=2027-01-31", secretariat)).status).toBe(403);
  });
});

describe("sweeper", () => {
  it("expires requests, marks no-shows and completes past bookings, once", async () => {
    await insertPack(ids.V, ids.hot, 600, "2027-06-01", "2027-06-30");
    const request = await createBooking(h.db, h.centreId, portal(ids.V), input(ids.V, ids.A1, ids.fHour, "2027-06-10", "09:00"), at("2027-06-01T08:00:00Z"));
    expect(request.booking.status).toBe("requested");
    expect(await sweepCoworking(h.db, at("2027-06-02T07:59:00Z"))).toBeGreaterThan(0);
    expect((await h.db.selectFrom("cw_bookings").select("status").where("id", "=", request.booking.id).executeTakeFirstOrThrow()).status).toBe("requested");
    await sweepCoworking(h.db, at("2027-06-02T08:00:00Z"));
    expect((await h.db.selectFrom("cw_bookings").select("status").where("id", "=", request.booking.id).executeTakeFirstOrThrow()).status).toBe("expired");
    expect((await usageOf(request.booking.id)).map((u) => u.status)).toEqual(["released"]);

    const absent = (await book(ids.W, ids.A2, ids.fHour, "2027-06-11", "09:00")).body.id;
    const present = (await book(ids.W, ids.A3, ids.fHour, "2027-06-11", "09:00")).body.id;
    await checkIn(h.db, h.centreId, { bookingId: present }, { source: "staff", userId: ids.adminUser! }, at("2027-06-11T08:05:00Z"));
    await sweepCoworking(h.db, at("2027-06-11T08:29:00Z"));
    expect((await h.db.selectFrom("cw_bookings").select("status").where("id", "=", absent).executeTakeFirstOrThrow()).status).toBe("confirmed");
    expect(await sweepCoworking(h.db, at("2027-06-11T08:30:00Z"))).toBe(1);
    expect((await h.db.selectFrom("cw_bookings").select("status").where("id", "=", absent).executeTakeFirstOrThrow()).status).toBe("no_show");
    expect((await chargesOf(absent)).map((c) => c.status)).toEqual(["open"]);
    const [first, second] = await Promise.all([sweepCoworking(h.db, at("2027-06-11T09:00:00Z")), sweepCoworking(h.db, at("2027-06-11T09:00:00Z"))]);
    expect(first + second).toBe(1);
    expect((await h.db.selectFrom("cw_bookings").select("status").where("id", "=", present).executeTakeFirstOrThrow()).status).toBe("completed");
    expect(await sweepCoworking(h.db, at("2027-06-11T09:00:00Z"))).toBe(0);
  });
});
