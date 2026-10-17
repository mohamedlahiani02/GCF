import { addDays, todayIn } from "@gcf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth/passwords.js";
import { createHarness, ORIGIN, PASSWORD, PUBLIC_ORIGIN, RecordingMailer, type Harness } from "./harness.js";

let h: Harness;
let secretariat: string;
const mailer = new RecordingMailer();
const ids: Record<string, string> = {};
const today = todayIn("Africa/Tunis");

type Slot = { startTime: string; startsAt: string; free: number };

async function settings(values: Record<string, unknown>) {
  await h.db.updateTable("cw_settings").set(values).where("centre_id", "=", h.centreId).execute();
}

/** An active portal account with the shared test password. */
async function insertMember(firstName: string, extra: Record<string, unknown> = {}): Promise<string> {
  const row = await h.db
    .insertInto("members")
    .values({
      centre_id: h.centreId,
      kind: "member",
      first_name: firstName,
      last_name: "Test",
      email: `${firstName.toLowerCase()}@portal.test`,
      phone: "20 000 000",
      status: "active",
      password_hash: await hashPassword(PASSWORD),
      notes: null,
      created_by: null,
      ...extra,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function login(email: string, password = PASSWORD): Promise<string> {
  const res = await h.callPublic("POST", "/api/portal/auth/login", undefined, { email, password });
  expect(res.status).toBe(200);
  const cookie = res.cookies.find((c) => c.name === "gcf_member");
  return `gcf_member=${cookie!.value}`;
}

async function subscribe(memberId: string, entitlements: unknown[]): Promise<string> {
  const plan = await h.db
    .insertInto("cw_plans")
    .values({ centre_id: h.centreId, name: `Plan ${memberId.slice(0, 8)}`, period: "month", price: 300_000, billing: "upfront" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const row = await h.db
    .insertInto("cw_subscriptions")
    .values({
      centre_id: h.centreId,
      member_id: memberId,
      plan_id: plan.id,
      starts_on: today,
      ends_on: addDays(today, 29),
      price: 300_000,
      billing: "upfront",
      includes_domiciliation: true,
      entitlements: JSON.stringify(entitlements),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

const book = (cookie: string, resourceId: string, formatId: string, date: string, startTime: string, extra: Record<string, unknown> = {}) =>
  h.callPublic("POST", "/api/portal/bookings", cookie, { resourceId, formatId, date, startTime, ...extra });

const chargesOf = (bookingId: string) =>
  h.db.selectFrom("installments").select(["label", "amount", "status"]).where("cw_booking_id", "=", bookingId).orderBy("created_at").execute();

beforeAll(async () => {
  h = await createHarness({ mailer });
  await h.setModules(["training", "coworking"]);
  await h.createUser("secretariat", "sec@portal.test");
  secretariat = await h.login("sec@portal.test");
  await h.db
    .updateTable("centres")
    .set({ open_from: "08:00", open_to: "20:00", open_weekdays: [1, 2, 3, 4, 5, 6, 7], address: "12, rue de Carthage; Tunis" })
    .where("id", "=", h.centreId)
    .execute();
  await h.db
    .insertInto("cw_settings")
    .values({
      centre_id: h.centreId,
      booking_horizon_days: 30,
      min_notice_minutes: 0,
      max_active_bookings: 10,
      approval_mode: "visitors",
      free_cancel_hours: 24,
      late_cancel_fee_bp: 5000,
      self_signup: "open",
      portal_enabled: true,
    })
    .execute();
  ids.floor = (await h.db.insertInto("cw_floors").values({ centre_id: h.centreId, name: "RDC" }).returning("id").executeTakeFirstOrThrow()).id;
  const type = async (name: string, category: string, extra: Record<string, unknown> = {}) =>
    (
      await h.db
        .insertInto("cw_resource_types")
        .values({ centre_id: h.centreId, name, category: category as "hot_desk", ...extra })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  const resource = async (code: string, typeId: string, capacity = 1) =>
    (
      await h.db
        .insertInto("cw_resources")
        .values({ centre_id: h.centreId, type_id: typeId, floor_id: ids.floor!, code, capacity })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  const format = async (typeId: string, label: string, durationMinutes: number, prices: { profile: "visitor" | "member"; amount: number }[]) => {
    const row = await h.db
      .insertInto("cw_booking_formats")
      .values({ centre_id: h.centreId, type_id: typeId, label, nature: "fixed", duration_minutes: durationMinutes, start_step_minutes: 60 })
      .returning("id")
      .executeTakeFirstOrThrow();
    if (prices.length)
      await h.db
        .insertInto("cw_prices")
        .values(prices.map((p) => ({ format_id: row.id, profile: p.profile, amount: p.amount })))
        .execute();
    return row.id;
  };
  ids.hot = await type("Open space", "hot_desk");
  ids.meet = await type("Salle de réunion", "meeting_room");
  ids.hidden = await type("Salle privée", "meeting_room", { public: false });
  ids.dedicated = await type("Bureau dédié", "dedicated_desk");
  ids.h1 = await resource("H-1", ids.hot);
  ids.h2 = await resource("H-2", ids.hot);
  ids.m1 = await resource("M-1", ids.meet, 8);
  ids.m2 = await resource("M-2", ids.meet, 4);
  ids.x1 = await resource("X-1", ids.hidden);
  ids.d1 = await resource("D-1", ids.dedicated);
  ids.halfDay = await format(ids.hot, "Demi-journée", 240, [
    { profile: "visitor", amount: 20_000 },
    { profile: "member", amount: 12_000 },
  ]);
  ids.hour = await format(ids.meet, "1 heure", 60, [{ profile: "visitor", amount: 30_000 }]);
  ids.unpriced = await format(ids.meet, "Journée", 480, []);
  ids.hiddenHour = await format(ids.hidden, "1 heure", 60, [{ profile: "visitor", amount: 10_000 }]);
});

afterAll(async () => {
  await h.close();
});

describe("client portal", () => {
  it("is unavailable when the coworking module is off or the portal is disabled", async () => {
    await h.setModules(["training", "website"]);
    for (const url of ["/api/portal/info", "/api/portal/auth/session", "/api/portal/catalogue"]) {
      const res = await h.callPublic("GET", url);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("portal_unavailable");
    }
    await h.setModules(["training"]);
    expect((await h.callPublic("GET", "/api/portal/info")).body.code).toBe("public_unavailable");
    await h.setModules(["training", "coworking"]);

    await settings({ portal_enabled: false });
    const login = await h.callPublic("POST", "/api/portal/auth/login", undefined, { email: "x@portal.test", password: PASSWORD });
    expect(login.status).toBe(404);
    expect(login.body.code).toBe("portal_unavailable");
    const info = await h.callPublic("GET", "/api/portal/info");
    expect(info.status).toBe(200);
    expect(info.body.portalEnabled).toBe(false);
    await settings({ portal_enabled: true });

    const open = await h.callPublic("GET", "/api/portal/info");
    expect(open.body).toMatchObject({
      portalEnabled: true,
      centre: { name: "Centre de test", address: "12, rue de Carthage; Tunis" },
      logoUrl: null,
      selfSignup: "open",
      languages: ["fr", "en"],
      colors: null,
      openingHours: { from: "08:00", to: "20:00", weekdays: [1, 2, 3, 4, 5, 6, 7] },
    });
  });

  it("refuses state-changing calls from another origin", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/portal/auth/login",
      headers: { host: new URL(PUBLIC_ORIGIN).host, origin: ORIGIN },
      payload: { email: "x@portal.test", password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("bad_origin");
  });

  it("signs up in the three modes and creates a company only for a new name", async () => {
    const signup = (email: string, extra: Record<string, unknown> = {}) =>
      h.callPublic("POST", "/api/portal/auth/signup", undefined, {
        email,
        password: PASSWORD,
        firstName: "Sami",
        lastName: "Ben Ali",
        phone: "22 111 222",
        ...extra,
      });

    const open = await signup("Sami@Portal.test", { companyName: "Acme SARL" });
    expect(open.status).toBe(201);
    expect(open.body).toMatchObject({
      status: "active",
      member: { email: "sami@portal.test", firstName: "Sami", emailVerified: false, company: { name: "Acme SARL", role: "member" } },
    });
    const cookie = open.headers["set-cookie"]!.toString();
    expect(cookie).toMatch(/^gcf_member=/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    const session = await h.callPublic("GET", "/api/portal/auth/session", `gcf_member=${open.cookies[0]!.value}`);
    expect(session.body.member.email).toBe("sami@portal.test");

    const sameName = await signup("rim@portal.test", { firstName: "Rim", companyName: "acme sarl" });
    expect(sameName.status).toBe(201);
    expect(sameName.body.member.company).toBeNull();
    expect((await h.db.selectFrom("companies").select("id").execute()).length).toBe(1);

    const taken = await signup("sami@portal.test");
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe("email_taken");
    expect((await signup("short@portal.test", { password: "short" })).status).toBe(400);
    expect((await signup("x@portal.test", { status: "active" })).status).toBe(400);

    await settings({ self_signup: "validated" });
    const pending = await signup("nour@portal.test", { firstName: "Nour" });
    expect(pending.status).toBe(201);
    expect(pending.body).toEqual({ status: "pending" });
    expect(pending.cookies).toEqual([]);
    const wrong = await h.callPublic("POST", "/api/portal/auth/login", undefined, { email: "nour@portal.test", password: "wrong-password-1" });
    expect(wrong.body.code).toBe("invalid_credentials");
    const waiting = await h.callPublic("POST", "/api/portal/auth/login", undefined, { email: "nour@portal.test", password: PASSWORD });
    expect(waiting.status).toBe(403);
    expect(waiting.body.code).toBe("account_pending");
    const nour = await h.db.selectFrom("members").select("id").where("email", "=", "nour@portal.test").executeTakeFirstOrThrow();
    expect((await h.call("POST", `/api/coworking/members/${nour.id}/validate`, secretariat)).status).toBe(200);
    await login("nour@portal.test");

    await settings({ self_signup: "closed" });
    const closed = await signup("late@portal.test");
    expect(closed.status).toBe(403);
    expect(closed.body.code).toBe("signup_closed");
    await settings({ self_signup: "open" });

    const audit = await h.db.selectFrom("audit_log").select(["action", "user_id", "object_type"]).where("action", "=", "member.signed_up").execute();
    expect(audit).toHaveLength(3);
    expect(audit.every((a) => a.user_id === null && a.object_type === "member")).toBe(true);
  });

  it("locks an account after repeated failures, like the staff login", async () => {
    await insertMember("Lock");
    for (let i = 0; i < 5; i += 1) {
      const res = await h.callPublic("POST", "/api/portal/auth/login", undefined, { email: "lock@portal.test", password: "not-the-password" });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("invalid_credentials");
    }
    const locked = await h.callPublic("POST", "/api/portal/auth/login", undefined, { email: "lock@portal.test", password: PASSWORD });
    expect(locked.status).toBe(423);
    expect(locked.body.code).toBe("account_locked");
    const unknown = await h.callPublic("POST", "/api/portal/auth/login", undefined, { email: "nobody@portal.test", password: PASSWORD });
    expect(unknown.body.code).toBe("invalid_credentials");
  });

  it("keeps member and staff sessions apart", async () => {
    await insertMember("Isolated");
    const member = await login("isolated@portal.test");
    expect((await h.call("GET", "/api/auth/session", member)).status).toBe(401);
    expect((await h.callPublic("GET", "/api/portal/auth/session", secretariat)).status).toBe(401);
    expect((await h.callPublic("GET", "/api/portal/auth/session", member)).status).toBe(200);
    const logout = await h.callPublic("POST", "/api/portal/auth/logout", member);
    expect(logout.status).toBe(204);
    expect((await h.callPublic("GET", "/api/portal/auth/session", member)).status).toBe(401);
  });

  it("resets a forgotten password with a single-use link", async () => {
    await insertMember("Forgot");
    const old = await login("forgot@portal.test");
    const before = mailer.sent.length;
    expect((await h.callPublic("POST", "/api/portal/auth/forgot", undefined, { email: "nobody@portal.test" })).status).toBe(204);
    expect(mailer.sent.length).toBe(before);
    expect((await h.callPublic("POST", "/api/portal/auth/forgot", undefined, { email: "forgot@portal.test" })).status).toBe(204);
    const sent = mailer.sent.at(-1)!;
    expect(sent.to).toBe("forgot@portal.test");
    const token = decodeURIComponent(/\/espace\/mot-de-passe\?token=([^\s]+)/.exec(sent.text)![1]!);

    const reset = await h.callPublic("POST", "/api/portal/auth/reset", undefined, { token, password: "a-brand-new-password" });
    expect(reset.status).toBe(200);
    expect(reset.body.member.emailVerified).toBe(true);
    expect(reset.cookies.map((c) => c.name)).toEqual(["gcf_member"]);
    expect((await h.callPublic("GET", "/api/portal/auth/session", old)).status).toBe(401);
    const again = await h.callPublic("POST", "/api/portal/auth/reset", undefined, { token, password: "another-new-password" });
    expect(again.status).toBe(422);
    expect(again.body.code).toBe("invalid_token");
    await login("forgot@portal.test", "a-brand-new-password");
  });

  it("activates an invited account from the staff invitation", async () => {
    const created = await h.call("POST", "/api/coworking/members", secretariat, {
      kind: "member",
      firstName: "Invite",
      lastName: "Test",
      email: "invite@portal.test",
    });
    expect(created.status).toBe(201);
    const invite = await h.call("POST", `/api/coworking/members/${created.body.id}/invite`, secretariat);
    expect(invite.status).toBe(200);
    const sent = mailer.sent.at(-1)!;
    const token = decodeURIComponent(/\/espace\/activation\?token=([^\s]+)/.exec(sent.text)![1]!);
    const wrongPurpose = await h.callPublic("POST", "/api/portal/auth/reset", undefined, { token, password: "invited-password-1" });
    expect(wrongPurpose.body.code).toBe("invalid_token");
    const activated = await h.callPublic("POST", "/api/portal/auth/activate", undefined, { token, password: "invited-password-1" });
    expect(activated.status).toBe(200);
    expect(activated.body.member).toMatchObject({ email: "invite@portal.test", emailVerified: true });
    expect((await h.callPublic("POST", "/api/portal/auth/activate", undefined, { token, password: "invited-password-2" })).body.code).toBe("invalid_token");
    await login("invite@portal.test", "invited-password-1");
  });

  it("updates the profile and changes the password", async () => {
    await insertMember("Profile");
    const cookie = await login("profile@portal.test");
    const other = await login("profile@portal.test");
    const patched = await h.callPublic("PATCH", "/api/portal/me", cookie, { phone: "98 765 432", lastName: "Nouveau" });
    expect(patched.status).toBe(200);
    expect(patched.body.member).toMatchObject({ phone: "98 765 432", lastName: "Nouveau" });
    expect((await h.callPublic("PATCH", "/api/portal/me", cookie, { email: "new@portal.test" })).status).toBe(400);

    const wrong = await h.callPublic("POST", "/api/portal/me/password", cookie, { currentPassword: "nope", newPassword: "changed-password-1" });
    expect(wrong.body.code).toBe("invalid_credentials");
    const changed = await h.callPublic("POST", "/api/portal/me/password", cookie, { currentPassword: PASSWORD, newPassword: "changed-password-1" });
    expect(changed.status).toBe(204);
    const fresh = `gcf_member=${changed.cookies[0]!.value}`;
    expect((await h.callPublic("GET", "/api/portal/auth/session", other)).status).toBe(401);
    expect((await h.callPublic("GET", "/api/portal/auth/session", fresh)).status).toBe(200);
    const audit = await h.db.selectFrom("audit_log").select(["action", "after"]).where("action", "in", ["member.updated", "member.password_changed"]).execute();
    expect(audit.map((a) => a.action).sort()).toEqual(["member.password_changed", "member.updated"]);
    expect(audit.every((a) => (a.after as { source: string }).source === "portal")).toBe(true);
  });

  it("prices the catalogue for the member's profile", async () => {
    ids.visitor = await insertMember("Visitor");
    ids.subscriber = await insertMember("Subscriber");
    ids.subscription = await subscribe(ids.subscriber, [{ typeId: ids.hot, quotaKind: "minutes", quota: 600 }]);
    const visitor = await login("visitor@portal.test");
    const subscriber = await login("subscriber@portal.test");
    ids.visitorCookie = visitor;
    ids.subscriberCookie = subscriber;

    const seen = await h.callPublic("GET", "/api/portal/catalogue", visitor);
    expect(seen.status).toBe(200);
    expect(seen.body.profile).toBe("visitor");
    expect(seen.body.types.map((t: { name: string }) => t.name)).toEqual(["Open space", "Salle de réunion"]);
    const meet = seen.body.types.find((t: { id: string }) => t.id === ids.meet);
    expect(meet.capacity).toEqual({ min: 4, max: 8 });
    expect(meet.floors).toEqual([{ id: ids.floor, name: "RDC" }]);
    expect(meet.formats.map((f: { label: string }) => f.label)).toEqual(["1 heure"]);
    expect(seen.body.types[0].formats[0].price).toEqual({ amount: 20_000, offpeakAmount: null, perHour: false, profile: "visitor" });

    const member = await h.callPublic("GET", "/api/portal/catalogue", subscriber);
    expect(member.body.profile).toBe("member");
    expect(member.body.types[0].formats[0].price.amount).toBe(12_000);
    expect(member.body.types[1].formats[0].price).toMatchObject({ amount: 30_000, profile: "visitor" });
    expect((await h.callPublic("GET", "/api/portal/catalogue")).status).toBe(401);
  });

  it("lists free slots within the horizon and shows the floor without personal data", async () => {
    const date = addDays(today, 5);
    const slots = await h.callPublic("GET", `/api/portal/formats/${ids.hour}/slots?date=${date}`, ids.visitorCookie);
    expect(slots.status).toBe(200);
    expect(slots.body.slots).toHaveLength(12);
    expect(slots.body.slots[0]).toMatchObject({ startTime: "08:00", endTime: "09:00", free: 2 });
    const far = await h.callPublic("GET", `/api/portal/formats/${ids.hour}/slots?date=${addDays(today, 31)}`, ids.visitorCookie);
    expect(far.body.code).toBe("beyond_horizon");
    expect((await h.callPublic("GET", `/api/portal/formats/${ids.hiddenHour}/slots?date=${date}`, ids.visitorCookie)).status).toBe(404);

    const state = await h.callPublic("GET", `/api/portal/floors/${ids.floor}/state?date=${date}&startTime=08:00&endTime=09:00`, ids.visitorCookie);
    expect(state.status).toBe(200);
    expect(state.body.floor).toMatchObject({ id: ids.floor, name: "RDC", planMediaId: null });
    expect(state.body.resources.every((r: Record<string, unknown>) => !("occupant" in r) && !("subscriber" in r))).toBe(true);
  });

  it("books as the signed-in member: requested or confirmed by approval mode, limits enforced", async () => {
    const date = addDays(today, 3);
    const quote = await h.callPublic("POST", "/api/portal/bookings/quote", ids.visitorCookie, {
      resourceId: ids.m1,
      formatId: ids.hour,
      date,
      startTime: "10:00",
    });
    expect(quote.status).toBe(200);
    expect(quote.body).toMatchObject({ memberId: ids.visitor, profile: "visitor", charge: 30_000, status: "requested" });

    const requested = await book(ids.visitorCookie, ids.m1, ids.hour, date, "10:00");
    expect(requested.status).toBe(201);
    expect(requested.body).toMatchObject({
      status: "requested",
      resourceCode: "M-1",
      floorName: "RDC",
      charge: 30_000,
      due: 0,
      cancellable: true,
      qrAvailable: false,
    });
    expect(await chargesOf(requested.body.id)).toEqual([]);
    ids.requested = requested.body.id;

    const confirmed = await book(ids.subscriberCookie, ids.m2, ids.hour, date, "10:00");
    expect(confirmed.body).toMatchObject({ status: "confirmed", charge: 30_000, due: 30_000, qrAvailable: true });
    ids.confirmed = confirmed.body.id;

    await settings({ approval_mode: "none" });
    const direct = await book(ids.visitorCookie, ids.m1, ids.hour, date, "11:00");
    expect(direct.body.status).toBe("confirmed");
    await settings({ approval_mode: "visitors" });

    const forced = await book(ids.visitorCookie, ids.m1, ids.hour, date, "12:00", { memberId: ids.subscriber });
    expect(forced.status).toBe(400);
    expect((await book(ids.visitorCookie, ids.m1, ids.hour, date, "12:00", { override: true })).status).toBe(400);
    const far = await book(ids.visitorCookie, ids.m1, ids.hour, addDays(today, 31), "12:00");
    expect(far.status).toBe(422);
    expect(far.body.code).toBe("beyond_horizon");
    await settings({ max_active_bookings: 2 });
    const tooMany = await book(ids.visitorCookie, ids.m1, ids.hour, date, "12:00");
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.code).toBe("too_many_active_bookings");
    await settings({ max_active_bookings: 10 });
    expect((await book(ids.visitorCookie, ids.x1, ids.hiddenHour, date, "12:00")).body.code).toBe("resource_not_bookable");

    const audit = await h.db.selectFrom("audit_log").select(["user_id", "after"]).where("object_id", "=", ids.requested).executeTakeFirstOrThrow();
    expect(audit.user_id).toBeNull();
    expect(audit.after).toMatchObject({ source: "portal", memberId: ids.visitor });
  });

  it("lists own bookings and hides those of other members", async () => {
    const upcoming = await h.callPublic("GET", "/api/portal/bookings?scope=upcoming", ids.visitorCookie);
    expect(upcoming.body.items.map((b: { startTime: string }) => b.startTime)).toEqual(["10:00", "11:00"]);
    expect((await h.callPublic("GET", "/api/portal/bookings?scope=past", ids.visitorCookie)).body.items).toEqual([]);
    const detail = await h.callPublic("GET", `/api/portal/bookings/${ids.confirmed}`, ids.subscriberCookie);
    expect(detail.body.charges).toEqual([expect.objectContaining({ amount: 30_000, paid: 0, remaining: 30_000 })]);

    for (const url of [
      `/api/portal/bookings/${ids.confirmed}`,
      `/api/portal/bookings/${ids.confirmed}/qr.svg`,
      `/api/portal/bookings/${ids.confirmed}/calendar.ics`,
    ]) {
      expect((await h.callPublic("GET", url, ids.visitorCookie)).status).toBe(404);
    }
    const cancel = await h.callPublic("POST", `/api/portal/bookings/${ids.confirmed}/cancel`, ids.visitorCookie, { reason: "Pas à moi" });
    expect(cancel.status).toBe(404);
  });

  it("serves the QR code only for a confirmed booking and the booking as an iCalendar file", async () => {
    const pending = await h.callPublic("GET", `/api/portal/bookings/${ids.requested}/qr.svg`, ids.visitorCookie);
    expect(pending.status).toBe(409);
    expect(pending.body.code).toBe("not_confirmed");
    const qr = await h.callPublic("GET", `/api/portal/bookings/${ids.confirmed}/qr.svg`, ids.subscriberCookie);
    expect(qr.status).toBe(200);
    expect(qr.headers["content-type"]).toContain("image/svg+xml");
    expect(qr.body).toContain("<svg");

    const ics = await h.callPublic("GET", `/api/portal/bookings/${ids.confirmed}/calendar.ics`, ids.subscriberCookie);
    expect(ics.status).toBe(200);
    expect(ics.headers["content-type"]).toContain("text/calendar");
    const text = ics.body as string;
    expect(text.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(text.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(text.split("\r\n").every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
    const unfolded = text.replace(/\r\n /g, "");
    expect(unfolded).toContain(`UID:cw-booking-${ids.confirmed}\r\n`);
    expect(unfolded).toMatch(/DTSTAMP:\d{8}T\d{6}Z\r\n/);
    const booking = await h.db.selectFrom("cw_bookings").select(["starts_at", "ends_at"]).where("id", "=", ids.confirmed).executeTakeFirstOrThrow();
    const stamp = (d: Date) =>
      d
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z")
        .replace(/[-:]/g, "");
    expect(unfolded).toContain(`DTSTART:${stamp(booking.starts_at)}\r\n`);
    expect(unfolded).toContain(`DTEND:${stamp(booking.ends_at)}\r\n`);
    expect(unfolded).toContain("SUMMARY:Salle de réunion M-2\\, Centre de test\r\n");
    expect(unfolded).toContain("LOCATION:12\\, rue de Carthage\\; Tunis\r\n");
    expect(unfolded).toContain("STATUS:CONFIRMED\r\n");
  });

  it("cancels for free in time and with a fee when late", async () => {
    const free = await h.callPublic("POST", `/api/portal/bookings/${ids.confirmed}/cancel`, ids.subscriberCookie, { reason: "Réunion déplacée" });
    expect(free.status).toBe(200);
    expect(free.body).toMatchObject({ status: "cancelled", free: true, fee: 0, cancellable: false, cancelReason: "Réunion déplacée" });
    expect(await chargesOf(ids.confirmed)).toEqual([expect.objectContaining({ amount: 30_000, status: "cancelled" })]);

    await insertMember("Late");
    const cookie = await login("late@portal.test");
    await settings({ approval_mode: "none" });
    const first: Slot[] = (await h.callPublic("GET", `/api/portal/formats/${ids.hour}/slots?date=${today}`, cookie)).body.slots;
    const second: Slot[] = (await h.callPublic("GET", `/api/portal/formats/${ids.hour}/slots?date=${addDays(today, 1)}`, cookie)).body.slots;
    const date = first.length ? today : addDays(today, 1);
    const slot = (first.length ? first : second)[0]!;
    expect(new Date(slot.startsAt).getTime() - Date.now()).toBeLessThan(24 * 3_600_000);
    const booked = await book(cookie, ids.m2, ids.hour, date, slot.startTime);
    expect(booked.body).toMatchObject({ status: "confirmed", cancellation: { free: false, fee: 15_000 } });
    await settings({ approval_mode: "visitors" });
    const cancelled = await h.callPublic("POST", `/api/portal/bookings/${booked.body.id}/cancel`, cookie, { reason: "Empêchement" });
    expect(cancelled.body).toMatchObject({ status: "cancelled", free: false, fee: 15_000, lateCancelFee: 15_000, due: 15_000 });
    expect((await chargesOf(booked.body.id)).map((c) => [c.amount, c.status])).toEqual([
      [30_000, "cancelled"],
      [15_000, "open"],
    ]);
    const audit = await h.db
      .selectFrom("audit_log")
      .select(["user_id", "after"])
      .where("object_id", "=", booked.body.id)
      .where("action", "=", "cw_booking.cancelled")
      .executeTakeFirstOrThrow();
    expect(audit.user_id).toBeNull();
    expect(audit.after).toMatchObject({ by: "portal", fee: 15_000 });
  });

  it("shows the subscription quota left after a covered booking, and packs", async () => {
    const booked = await book(ids.subscriberCookie, ids.h1, ids.halfDay, addDays(today, 4), "08:00");
    expect(booked.status).toBe(201);
    expect(booked.body).toMatchObject({ status: "confirmed", coveredMinutes: 240, charge: 0 });
    const subscription = await h.callPublic("GET", "/api/portal/subscription", ids.subscriberCookie);
    expect(subscription.status).toBe(200);
    expect(subscription.body.items).toHaveLength(1);
    expect(subscription.body.items[0]).toMatchObject({
      id: ids.subscription,
      state: "current",
      includesDomiciliation: true,
      window: { start: today },
      entitlements: [{ typeId: ids.hot, typeName: "Open space", quotaKind: "minutes", quota: 600, used: 240, remaining: 360 }],
    });

    const product = await h.db
      .insertInto("cw_pack_products")
      .values({ centre_id: h.centreId, name: "Pack 10 h", type_id: ids.meet, quota_kind: "minutes", quota: 600, validity_days: 90, price: 50_000 })
      .returning("id")
      .executeTakeFirstOrThrow();
    await h.db
      .insertInto("cw_packs")
      .values({
        centre_id: h.centreId,
        member_id: ids.subscriber,
        product_id: product.id,
        type_id: ids.meet,
        quota_kind: "minutes",
        quota: 600,
        price: 50_000,
        starts_on: today,
        expires_on: addDays(today, 89),
      })
      .execute();
    const packs = await h.callPublic("GET", "/api/portal/packs", ids.subscriberCookie);
    expect(packs.body.items).toEqual([expect.objectContaining({ productName: "Pack 10 h", used: 0, remaining: 600, state: "active" })]);
    expect((await h.callPublic("GET", "/api/portal/packs", ids.visitorCookie)).body.items).toEqual([]);
  });

  it("gives access to the member's own receipts, account and mail only", async () => {
    const payment = await h.call("POST", "/api/payments", secretariat, { memberId: ids.visitor, amount: 30_000, method: "cash" });
    expect(payment.status).toBe(201);
    const account = await h.callPublic("GET", "/api/portal/account", ids.visitorCookie);
    expect(account.status).toBe(200);
    expect(account.body.totals.credit).toBeGreaterThanOrEqual(0);
    const receiptId = account.body.payments[0].receiptId as string;
    expect(account.body.payments[0]).toMatchObject({ amount: 30_000, method: "cash", receiptNumber: expect.any(String) });
    const pdf = await h.callPublic("GET", `/api/portal/receipts/${receiptId}/pdf`, ids.visitorCookie);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect((await h.callPublic("GET", `/api/portal/receipts/${receiptId}/pdf`, ids.subscriberCookie)).status).toBe(404);
    expect(await h.db.selectFrom("receipt_prints").select("id").execute()).toEqual([]);

    await h.db
      .insertInto("cw_mail_items")
      .values({ centre_id: h.centreId, member_id: ids.subscriber, kind: "letter", sender: "CNSS", notes: "Rangé casier 4" })
      .execute();
    const mail = await h.callPublic("GET", "/api/portal/mail", ids.subscriberCookie);
    expect(mail.body.items).toEqual([expect.objectContaining({ kind: "letter", sender: "CNSS", status: "received" })]);
    expect(mail.body.items[0]).not.toHaveProperty("notes");
    expect((await h.callPublic("GET", "/api/portal/mail", ids.visitorCookie)).body.items).toEqual([]);
  });

  it("shows the team to the company admin only", async () => {
    const company = await h.db
      .insertInto("companies")
      .values({ centre_id: h.centreId, name: "Team SA", tax_id: null, address: null, email: null, phone: null, status: "active", created_by: null })
      .returning("id")
      .executeTakeFirstOrThrow();
    await insertMember("Boss", { company_id: company.id, company_role: "admin" });
    const colleague = await insertMember("Colleague", { company_id: company.id, company_role: "member" });
    const boss = await login("boss@portal.test");
    const mate = await login("colleague@portal.test");
    await settings({ approval_mode: "none" });
    expect((await book(mate, ids.h2, ids.halfDay, addDays(today, 6), "12:00")).status).toBe(201);
    await settings({ approval_mode: "visitors" });

    const team = await h.callPublic("GET", "/api/portal/team", boss);
    expect(team.status).toBe(200);
    expect(team.body.company.name).toBe("Team SA");
    expect(team.body.members.map((m: { firstName: string; upcomingBookings: number; isMe: boolean }) => [m.firstName, m.upcomingBookings, m.isMe])).toEqual([
      ["Boss", 0, true],
      ["Colleague", 1, false],
    ]);
    const bookings = await h.callPublic("GET", "/api/portal/team/bookings", boss);
    expect(bookings.body.items).toEqual([
      expect.objectContaining({
        memberId: colleague,
        memberName: "Colleague Test",
        date: addDays(today, 6),
        startTime: "12:00",
        endTime: "16:00",
        resourceCode: "H-2",
      }),
    ]);
    expect(bookings.body.items[0]).not.toHaveProperty("charge");
    expect((await h.callPublic("GET", "/api/portal/team", mate)).status).toBe(403);
    expect((await h.callPublic("GET", "/api/portal/team/bookings", ids.visitorCookie)).body.code).toBe("forbidden");
  });
});
