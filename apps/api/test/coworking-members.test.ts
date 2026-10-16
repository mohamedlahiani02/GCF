import { addDays, addMonthsClamped, todayIn } from "@gcf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consumeMemberToken } from "../src/auth/memberTokens.js";
import { autoRenewSubscriptions } from "../src/domain/coworking/subscriptions.js";
import { createHarness, RecordingMailer, type Harness } from "./harness.js";

let h: Harness;
let admin: string;
let secretariat: string;
let accountant: string;
const mailer = new RecordingMailer();
const ids: Record<string, string> = {};
const today = todayIn("Africa/Tunis");

type Instalment = { amount: number; dueDate: string; status: string; state: string };

async function newMember(firstName: string, email?: string): Promise<string> {
  const res = await h.call("POST", "/api/coworking/members", secretariat, {
    kind: "member",
    firstName,
    lastName: "Test",
    email: email ?? `${firstName.toLowerCase()}@client.tn`,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  h = await createHarness({ mailer });
  await h.setModules(["training", "coworking"]);
  await h.createUser("admin", "admin@mbr.tn");
  await h.createUser("secretariat", "sec@mbr.tn");
  await h.createUser("accountant", "compta@mbr.tn");
  admin = await h.login("admin@mbr.tn");
  secretariat = await h.login("sec@mbr.tn");
  accountant = await h.login("compta@mbr.tn");
  const floor = (await h.call("POST", "/api/coworking/floors", admin, { name: "RDC" })).body.id;
  ids.hotDesk = (await h.call("POST", "/api/coworking/resource-types", admin, { name: "Poste flexible", category: "hot_desk" })).body.id;
  ids.dedicated = (await h.call("POST", "/api/coworking/resource-types", admin, { name: "Bureau dédié", category: "dedicated_desk" })).body.id;
  ids.desk = (await h.call("POST", "/api/coworking/resources", admin, { code: "F-1", typeId: ids.hotDesk, floorId: floor })).body.id;
  ids.d1 = (await h.call("POST", "/api/coworking/resources", admin, { code: "D-1", typeId: ids.dedicated, floorId: floor })).body.id;
  ids.domicile = (
    await h.call("POST", "/api/coworking/plans", admin, {
      name: "Domiciliation",
      period: "month",
      price: 120_000,
      billing: "upfront",
      includesDomiciliation: true,
      entitlements: [{ typeId: ids.hotDesk, quotaKind: "bookings", quota: 2 }],
    })
  ).body.id;
  ids.resident = (
    await h.call("POST", "/api/coworking/plans", admin, {
      name: "Résident",
      period: "quarter",
      price: 1_000_000,
      billing: "monthly",
      assignedTypeId: ids.dedicated,
    })
  ).body.id;
  ids.packProduct = (
    await h.call("POST", "/api/coworking/pack-products", admin, {
      name: "5 passages",
      typeId: ids.hotDesk,
      quotaKind: "bookings",
      quota: 5,
      validityDays: 30,
      price: 45_000,
    })
  ).body.id;
});

afterAll(async () => {
  await h.close();
});

describe("coworking members", () => {
  it("creates members and guests, searches them and converts a guest", async () => {
    expect((await h.call("POST", "/api/coworking/members", secretariat, { kind: "member", firstName: "Sans" })).body.code).toBe("email_required");
    const company = await h.call("POST", "/api/coworking/companies", secretariat, { name: "Startup SARL", taxId: "1234567A" });
    expect(company.status).toBe(201);
    const amira = await h.call("POST", "/api/coworking/members", secretariat, {
      kind: "member",
      firstName: "Amira",
      lastName: "Ben Salah",
      email: "Amira@Client.tn",
      phone: "98 000 111",
      companyId: company.body.id,
    });
    expect(amira.status).toBe(201);
    expect(amira.body).toMatchObject({ email: "amira@client.tn", companyName: "Startup SARL", companyRole: "member", status: "active", hasPassword: false });
    ids.amira = amira.body.id;
    const guest = await h.call("POST", "/api/coworking/members", secretariat, { kind: "guest", firstName: "Karim" });
    expect(guest.status).toBe(201);
    ids.guest = guest.body.id;

    const found = await h.call("GET", "/api/coworking/members?q=startup", accountant);
    expect(found.body.items.map((m: { id: string }) => m.id)).toEqual([ids.amira]);
    expect((await h.call("GET", "/api/coworking/members?kind=guest", accountant)).body.total).toBe(1);
    expect((await h.call("GET", `/api/coworking/companies/${company.body.id}/members`, accountant)).body).toHaveLength(1);
    const search = await h.call("GET", "/api/search?q=amira", accountant);
    expect(search.body.members.map((m: { id: string }) => m.id)).toEqual([ids.amira]);

    const taken = await h.call("POST", `/api/coworking/members/${ids.guest}/convert`, secretariat, { email: "amira@client.tn" });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe("email_taken");
    const converted = await h.call("POST", `/api/coworking/members/${ids.guest}/convert`, secretariat, { email: "karim@client.tn", lastName: "Trabelsi" });
    expect(converted.body).toMatchObject({ id: ids.guest, kind: "member", email: "karim@client.tn", lastName: "Trabelsi" });
    expect((await h.call("POST", `/api/coworking/members/${ids.guest}/convert`, secretariat, { email: "x@client.tn" })).body.code).toBe("not_a_guest");
  });

  it("keeps accountants out of member writes", async () => {
    expect((await h.call("POST", "/api/coworking/members", accountant, { kind: "guest", firstName: "Non" })).status).toBe(403);
    expect((await h.call("POST", "/api/coworking/subscriptions", accountant, { memberId: ids.amira, planId: ids.domicile, startsOn: today })).status).toBe(403);
    expect((await h.call("GET", `/api/coworking/members/${ids.amira}`, accountant)).status).toBe(200);
  });

  it("invites a member to the portal with a single-use activation link", async () => {
    const invite = await h.call("POST", `/api/coworking/members/${ids.amira}/invite`, secretariat);
    expect(invite.status).toBe(200);
    expect(invite.body.mail).toBe("sent");
    const mail = mailer.sent.at(-1)!;
    expect(mail.to).toBe("amira@client.tn");
    const token = decodeURIComponent(/activation\?token=([^\s]+)/.exec(mail.text)![1]!);
    expect(mail.text).toContain("https://www.cowork.test/espace/activation?token=");
    expect(await consumeMemberToken(h.db, token, "password_reset")).toBeUndefined();
    expect(await consumeMemberToken(h.db, token, "activation")).toEqual({ memberId: ids.amira });
    expect(await consumeMemberToken(h.db, token, "activation")).toBeUndefined();
    expect((await h.call("POST", `/api/coworking/members/${ids.amira}/invite`, accountant)).status).toBe(403);
  });

  it("sells an upfront subscription with one charge due on its first day", async () => {
    const res = await h.call("POST", "/api/coworking/subscriptions", secretariat, { memberId: ids.amira, planId: ids.domicile, startsOn: today });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      startsOn: today,
      endsOn: addDays(addMonthsClamped(today, 1), -1),
      price: 120_000,
      includesDomiciliation: true,
      state: "current",
      due: 120_000,
      entitlements: [{ typeId: ids.hotDesk, quotaKind: "bookings", quota: 2 }],
    });
    expect(res.body.installments.map((i: Instalment) => [i.amount, i.dueDate])).toEqual([[120_000, today]]);
    ids.domSub = res.body.id;
    const detail = await h.call("GET", `/api/coworking/members/${ids.amira}`, accountant);
    expect(detail.body.activeSubscription).toMatchObject({ id: ids.domSub, planName: "Domiciliation" });
    expect(detail.body.totals.due).toBe(120_000);
  });

  it("splits a monthly billed subscription with exact rounding and protects the assigned resource", async () => {
    expect((await h.call("POST", "/api/coworking/subscriptions", secretariat, { memberId: ids.guest, planId: ids.resident, startsOn: today })).body.code).toBe(
      "assigned_resource_required",
    );
    const res = await h.call("POST", "/api/coworking/subscriptions", secretariat, {
      memberId: ids.guest,
      planId: ids.resident,
      startsOn: today,
      assignedResourceId: ids.d1,
    });
    expect(res.status).toBe(201);
    expect(res.body.installments.map((i: Instalment) => [i.amount, i.dueDate])).toEqual([
      [333_334, today],
      [333_333, addMonthsClamped(today, 1)],
      [333_333, addMonthsClamped(today, 2)],
    ]);
    expect(res.body.assignedResourceCode).toBe("D-1");
    ids.residentSub = res.body.id;
    const other = await newMember("Sami");
    const overlap = await h.call("POST", "/api/coworking/subscriptions", secretariat, {
      memberId: other,
      planId: ids.resident,
      startsOn: addDays(today, 30),
      assignedResourceId: ids.d1,
    });
    expect(overlap.status).toBe(409);
    expect(overlap.body.code).toBe("resource_taken");
    const wrongType = await h.call("POST", "/api/coworking/subscriptions", secretariat, {
      memberId: other,
      planId: ids.resident,
      startsOn: today,
      assignedResourceId: ids.desk,
    });
    expect(wrongType.body.code).toBe("invalid_assigned_resource");
    const archive = await h.call("POST", `/api/coworking/resources/${ids.d1}/archive`, admin, { reason: "Retiré" });
    expect(archive.body.code).toBe("resource_assigned");
  });

  it("terminates a subscription and cancels the charges due after the new end", async () => {
    expect(
      (await h.call("POST", `/api/coworking/subscriptions/${ids.residentSub}/terminate`, secretariat, { endsOn: addDays(today, -1), reason: "Départ" })).body
        .code,
    ).toBe("end_before_today");
    expect(
      (await h.call("POST", `/api/coworking/subscriptions/${ids.residentSub}/terminate`, secretariat, { endsOn: addDays(today, 200), reason: "Départ" })).body
        .code,
    ).toBe("end_after_current");
    const res = await h.call("POST", `/api/coworking/subscriptions/${ids.residentSub}/terminate`, secretariat, {
      endsOn: addDays(today, 10),
      reason: "Départ anticipé",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ endsOn: addDays(today, 10), autoRenew: false, due: 333_334 });
    expect(res.body.installments.map((i: Instalment) => i.status)).toEqual(["open", "cancelled", "cancelled"]);
    const freed = await h.call("POST", "/api/coworking/subscriptions", secretariat, {
      memberId: await newMember("Lina"),
      planId: ids.resident,
      startsOn: addDays(today, 11),
      assignedResourceId: ids.d1,
    });
    expect(freed.status).toBe(201);
  });

  it("cancels a subscription only while nothing was paid, and shows the member account", async () => {
    const payment = await h.call("POST", "/api/payments", secretariat, { memberId: ids.amira, amount: 50_000, method: "cash" });
    expect(payment.status).toBe(201);
    const account = await h.call("GET", `/api/coworking/members/${ids.amira}/account`, accountant);
    expect(account.status).toBe(200);
    expect(account.body.totals).toEqual({ due: 70_000, credit: 0, pendingDiscounts: 0 });
    expect(account.body.installments.map((i: Instalment) => [i.amount, i.state])).toEqual([[120_000, "partial"]]);
    expect(account.body.payments).toEqual([expect.objectContaining({ amount: 50_000, method: "cash", receiptNumber: expect.any(String) })]);
    const refused = await h.call("POST", `/api/coworking/subscriptions/${ids.domSub}/cancel`, secretariat, { reason: "Erreur" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("installment_paid");

    const mistake = await h.call("POST", "/api/coworking/subscriptions", secretariat, {
      memberId: ids.guest,
      planId: ids.domicile,
      startsOn: addDays(today, 40),
    });
    const cancelled = await h.call("POST", `/api/coworking/subscriptions/${mistake.body.id}/cancel`, secretariat, { reason: "Mauvaise formule" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: "cancelled", state: "cancelled", cancelReason: "Mauvaise formule", due: 0 });
    expect(cancelled.body.installments.map((i: Instalment) => i.status)).toEqual(["cancelled"]);
    expect((await h.call("POST", `/api/coworking/subscriptions/${mistake.body.id}/cancel`, secretariat, { reason: "Encore" })).body.code).toBe(
      "already_cancelled",
    );
  });

  it("renews a subscription once, by hand or automatically", async () => {
    const renewal = await h.call("POST", `/api/coworking/subscriptions/${ids.domSub}/renew`, secretariat);
    expect(renewal.status).toBe(201);
    const end = addDays(addMonthsClamped(today, 1), -1);
    expect(renewal.body).toMatchObject({ startsOn: addDays(end, 1), renewedFromId: ids.domSub, price: 120_000, state: "upcoming" });
    expect((await h.call("POST", `/api/coworking/subscriptions/${ids.domSub}/renew`, secretariat)).body.code).toBe("already_renewed");
    expect((await h.call("POST", `/api/coworking/subscriptions/${ids.domSub}/terminate`, secretariat, { endsOn: today, reason: "x" })).body.code).toBe(
      "has_renewal",
    );

    const member = await newMember("Auto");
    const past = await h.call("POST", "/api/coworking/subscriptions", secretariat, {
      memberId: member,
      planId: ids.domicile,
      startsOn: addDays(today, -35),
      autoRenew: true,
    });
    expect(past.body.endsOn < today).toBe(true);
    expect((await h.call("PUT", `/api/coworking/subscriptions/${past.body.id}/auto-renew`, secretariat, { autoRenew: true })).body.code).toBe(
      "subscription_ended",
    );
    const [first, second] = await Promise.all([autoRenewSubscriptions(h.db), autoRenewSubscriptions(h.db)]);
    expect(first + second).toBe(1);
    expect(await autoRenewSubscriptions(h.db)).toBe(0);
    const renewed = await h.call("GET", `/api/coworking/subscriptions?memberId=${member}`, accountant);
    expect(renewed.body.total).toBe(2);
    const next = renewed.body.items.find((s: { renewedFromId: string | null }) => s.renewedFromId === past.body.id);
    expect(next).toMatchObject({ startsOn: addDays(past.body.endsOn, 1), autoRenew: true, state: "current" });
    const unpaid = await h.call("GET", `/api/coworking/subscriptions?unpaid=true&memberId=${member}`, accountant);
    expect(unpaid.body.total).toBe(2);
    const ending = await h.call("GET", "/api/coworking/subscriptions?endingWithinDays=12", accountant);
    expect(ending.body.items.map((s: { id: string }) => s.id)).toContain(ids.residentSub);
  });

  it("sells packs and cancels them only when unused and unpaid", async () => {
    const member = await newMember("Pack");
    const sold = await h.call("POST", "/api/coworking/packs", secretariat, { memberId: member, productId: ids.packProduct });
    expect(sold.status).toBe(201);
    expect(sold.body).toMatchObject({ quota: 5, remaining: 5, used: 0, startsOn: today, expiresOn: addDays(today, 29), state: "active" });
    const account = await h.call("GET", `/api/coworking/members/${member}/account`, accountant);
    expect(account.body.installments.map((i: Instalment) => [i.amount, i.dueDate])).toEqual([[45_000, today]]);
    const cancelled = await h.call("POST", `/api/coworking/packs/${sold.body.id}/cancel`, secretariat, { reason: "Erreur" });
    expect(cancelled.body.state).toBe("cancelled");

    const used = (await h.call("POST", "/api/coworking/packs", secretariat, { memberId: member, productId: ids.packProduct })).body.id;
    const startsAt = new Date(Date.now() + 86_400_000);
    const endsAt = new Date(startsAt.getTime() + 3_600_000);
    const booking = await h.db
      .insertInto("cw_bookings")
      .values({
        centre_id: h.centreId,
        resource_id: ids.desk,
        member_id: member,
        starts_at: startsAt,
        ends_at: endsAt,
        blocked_until: endsAt,
        status: "confirmed",
        source: "staff",
        profile: "visitor",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await h.db
      .insertInto("cw_entitlement_usage")
      .values({ centre_id: h.centreId, booking_id: booking.id, pack_id: used, quota_kind: "bookings", amount: 1 })
      .execute();
    const packs = await h.call("GET", `/api/coworking/members/${member}/packs`, accountant);
    expect(packs.body.find((p: { id: string }) => p.id === used)).toMatchObject({ used: 1, remaining: 4 });
    expect((await h.call("POST", `/api/coworking/packs/${used}/cancel`, secretariat, { reason: "Erreur" })).body.code).toBe("pack_used");

    const paid = (await h.call("POST", "/api/coworking/packs", secretariat, { memberId: member, productId: ids.packProduct })).body.id;
    await h.call("POST", "/api/payments", secretariat, { memberId: member, amount: 90_000, method: "cash" });
    expect((await h.call("POST", `/api/coworking/packs/${paid}/cancel`, secretariat, { reason: "Erreur" })).body.code).toBe("installment_paid");
  });

  it("registers domiciliation mail only for domiciled members and follows it to collection", async () => {
    const refused = await h.call("POST", "/api/coworking/mail-items", secretariat, { memberId: ids.guest, kind: "letter" });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("no_domiciliation");
    const item = await h.call("POST", "/api/coworking/mail-items", secretariat, { memberId: ids.amira, kind: "registered", sender: "CNSS" });
    expect(item.status).toBe(201);
    expect(item.body).toMatchObject({ status: "received", memberName: "Amira Ben Salah" });
    const domiciled = await h.call("GET", "/api/coworking/domiciliations", accountant);
    expect(domiciled.body.find((d: { memberId: string }) => d.memberId === ids.amira)).toMatchObject({ openMailCount: 1, planName: "Domiciliation" });

    const notified = await h.call("POST", `/api/coworking/mail-items/${item.body.id}/notify`, secretariat);
    expect(notified.body).toMatchObject({ status: "notified", mail: "sent" });
    expect(mailer.sent.at(-1)!.text).toContain("une lettre recommandée de la part de CNSS");
    expect((await h.call("POST", `/api/coworking/mail-items/${item.body.id}/collect`, secretariat, {})).status).toBe(400);
    const collected = await h.call("POST", `/api/coworking/mail-items/${item.body.id}/collect`, secretariat, { collectedByName: "Amira Ben Salah" });
    expect(collected.body).toMatchObject({ status: "collected", collectedByName: "Amira Ben Salah", handedBy: "secretariat user" });
    expect((await h.call("POST", `/api/coworking/mail-items/${item.body.id}/return`, secretariat, { reason: "Refusé" })).body.code).toBe("mail_item_closed");

    await h.call("POST", "/api/coworking/mail-items", secretariat, { memberId: ids.amira, kind: "parcel" });
    const list = await h.call("GET", "/api/coworking/mail-items", accountant);
    expect(list.body.items.map((m: { status: string }) => m.status)).toEqual(["received", "collected"]);
  });

  it("disables a member, signs them out and enables them again", async () => {
    await h.db
      .insertInto("member_sessions")
      .values({ member_id: ids.amira, token_hash: Buffer.alloc(32, 7), absolute_expires_at: new Date(Date.now() + 3_600_000) })
      .execute();
    const disabled = await h.call("POST", `/api/coworking/members/${ids.amira}/disable`, secretariat, { reason: "Impayés" });
    expect(disabled.body.status).toBe("disabled");
    expect(await h.db.selectFrom("member_sessions").select("id").where("member_id", "=", ids.amira).execute()).toEqual([]);
    expect((await h.call("POST", "/api/coworking/packs", secretariat, { memberId: ids.amira, productId: ids.packProduct })).body.code).toBe("member_disabled");
    expect((await h.call("POST", `/api/coworking/members/${ids.amira}/enable`, secretariat)).body.status).toBe("active");
  });

  it("validates a pending self sign-up and tells the member", async () => {
    const pending = await h.db
      .insertInto("members")
      .values({ centre_id: h.centreId, kind: "member", first_name: "Nour", email: "nour@client.tn", status: "pending", password_hash: "hash" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const validated = await h.call("POST", `/api/coworking/members/${pending.id}/validate`, secretariat);
    expect(validated.body).toMatchObject({ status: "active", mail: "sent", hasPassword: true });
    expect(mailer.sent.at(-1)!.to).toBe("nour@client.tn");
    expect((await h.call("POST", `/api/coworking/members/${pending.id}/validate`, secretariat)).body.code).toBe("member_not_pending");
    expect((await h.call("POST", `/api/coworking/members/${pending.id}/invite`, secretariat)).body.code).toBe("already_activated");
  });
});
