import { addDays, todayIn } from "@gcf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth/passwords.js";
import { purgeVisitors } from "../src/domain/coworking/visitors.js";
import { createHarness, PASSWORD, RecordingMailer, type Harness } from "./harness.js";

let h: Harness;
let secretariat: string;
let admin: string;
let selma: string;
let karim: string;
const mailer = new RecordingMailer();
const ids: Record<string, string> = {};
const today = todayIn("Africa/Tunis");

async function insertMember(firstName: string): Promise<string> {
  const row = await h.db
    .insertInto("members")
    .values({
      centre_id: h.centreId,
      kind: "member",
      first_name: firstName,
      last_name: "Test",
      email: `${firstName.toLowerCase()}@visit.test`,
      status: "active",
      password_hash: await hashPassword(PASSWORD),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function portalLogin(email: string): Promise<string> {
  const res = await h.callPublic("POST", "/api/portal/auth/login", undefined, { email, password: PASSWORD });
  expect(res.status).toBe(200);
  return `gcf_member=${res.cookies.find((c) => c.name === "gcf_member")!.value}`;
}

beforeAll(async () => {
  h = await createHarness({ mailer });
  await h.setModules(["training", "coworking"]);
  await h.createUser("secretariat", "sec@visit.test");
  await h.createUser("admin", "admin@visit.test");
  secretariat = await h.login("sec@visit.test");
  admin = await h.login("admin@visit.test");
  await h.db.insertInto("cw_settings").values({ centre_id: h.centreId, portal_enabled: true }).execute();
  ids.selma = await insertMember("Selma");
  ids.karim = await insertMember("Karim");
  selma = await portalLogin("selma@visit.test");
  karim = await portalLogin("karim@visit.test");
});

afterAll(async () => {
  await h.close();
});

describe("visitor register", () => {
  it("lets a client announce a guest and the desk see the day", async () => {
    const announced = await h.callPublic("POST", "/api/portal/visitors", selma, {
      name: "Nadia Orbite",
      company: "Orbite Studio",
      expectedOn: today,
      expectedAt: "10:30",
      purpose: "Réunion projet",
    });
    expect(announced.status).toBe(201);
    expect(announced.body).toMatchObject({ status: "expected", announcedBy: "portal", expectedAt: "10:30" });
    expect(announced.body.hostName).toBeUndefined();
    ids.nadia = announced.body.id;
    const past = await h.callPublic("POST", "/api/portal/visitors", selma, { name: "Hier", expectedOn: addDays(today, -1) });
    expect(past.body.code).toBe("visitor_date_past");
    const extra = await h.callPublic("POST", "/api/portal/visitors", selma, { name: "Tiers", expectedOn: today, hostMemberId: ids.karim });
    expect(extra.status).toBe(400);

    const walkIn = await h.call("POST", "/api/coworking/visitors", secretariat, { hostMemberId: ids.karim, name: "Livreur Valmer", expectedOn: today });
    expect(walkIn.body).toMatchObject({ announcedBy: "staff", hostName: "Karim Test" });
    ids.walkIn = walkIn.body.id;
    const day = await h.call("GET", `/api/coworking/visitors?date=${today}`, secretariat);
    expect(day.body.map((v: { name: string }) => v.name).sort()).toEqual(["Livreur Valmer", "Nadia Orbite"]);
    expect((await h.callPublic("GET", "/api/portal/visitors", karim)).body.map((v: { name: string }) => v.name)).toEqual(["Livreur Valmer"]);
  });

  it("records arrival and departure at the desk and tells the host", async () => {
    expect((await h.callPublic("POST", `/api/portal/visitors/${ids.nadia}/cancel`, karim)).status).toBe(404);
    const sent = mailer.sent.length;
    const arrived = await h.call("POST", `/api/coworking/visitors/${ids.nadia}/arrive`, secretariat);
    expect(arrived.body.status).toBe("arrived");
    expect(mailer.sent.length).toBe(sent + 1);
    expect(mailer.sent.at(-1)).toMatchObject({ to: "selma@visit.test", subject: "Votre visiteur Nadia Orbite est arrivé" });
    expect((await h.call("POST", `/api/coworking/visitors/${ids.nadia}/arrive`, secretariat)).body.code).toBe("visitor_wrong_status");
    expect((await h.callPublic("POST", `/api/portal/visitors/${ids.nadia}/cancel`, selma)).body.code).toBe("visitor_wrong_status");
    expect((await h.call("POST", `/api/coworking/visitors/${ids.nadia}/leave`, secretariat)).body.status).toBe("left");

    await h.call("PUT", "/api/coworking/settings", admin, { visitorNotifyHost: false });
    await h.call("POST", `/api/coworking/visitors/${ids.walkIn}/arrive`, secretariat);
    expect(mailer.sent.length).toBe(sent + 1);
  });

  it("lets the host cancel a visit to come", async () => {
    const later = await h.callPublic("POST", "/api/portal/visitors", karim, { name: "Sami Aurelle", expectedOn: addDays(today, 2) });
    const cancelled = await h.callPublic("POST", `/api/portal/visitors/${later.body.id}/cancel`, karim);
    expect(cancelled.body.status).toBe("cancelled");
    expect((await h.callPublic("GET", "/api/portal/visitors", karim)).body.map((v: { name: string }) => v.name)).toEqual(["Livreur Valmer"]);
  });

  it("deletes visits past the retention period", async () => {
    await h.call("PUT", "/api/coworking/settings", admin, { visitorRetentionDays: 30 });
    const now = new Date(`${addDays(today, 31)}T12:00:00Z`);
    expect(await purgeVisitors(h.db, new Date(`${addDays(today, 30)}T12:00:00Z`))).toBe(0);
    expect(await purgeVisitors(h.db, now)).toBe(2);
    expect((await h.call("GET", `/api/coworking/visitors?date=${today}`, secretariat)).body).toEqual([]);
  });
});
