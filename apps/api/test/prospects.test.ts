import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
let secretariat: string;
let accountant: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  h = await createHarness();
  await h.setModules(["training", "coworking", "website"]);
  ids.sec = await h.createUser("secretariat", "sec@crm.test");
  await h.createUser("accountant", "compta@crm.test");
  secretariat = await h.login("sec@crm.test");
  accountant = await h.login("compta@crm.test");
  ids.lead = (
    await h.db
      .insertInto("site_leads")
      .values({
        centre_id: h.centreId,
        kind: "visit",
        name: "Leila Aurelle",
        email: "leila@orbite.test",
        company: "Orbite Studio",
        message: "Bureau pour 4 personnes en janvier",
        language: "fr",
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
});

afterAll(async () => {
  await h.close();
});

describe("prospects", () => {
  it("creates tagged prospects and keeps them to the users who may see them", async () => {
    const tag = await h.call("POST", "/api/prospects/tags", secretariat, { name: "Entreprise", color: "#3D4EE0" });
    expect(tag.body.color).toBe("#3d4ee0");
    ids.tag = tag.body.id;
    expect((await h.call("POST", "/api/prospects/tags", secretariat, { name: "entreprise", color: "#000000" })).status).toBe(409);
    const created = await h.call("POST", "/api/prospects", secretariat, {
      name: "Youssef Valmont",
      phone: "55 100 200",
      source: "walk_in",
      interests: ["training"],
      nextAction: "Rappeler pour le planning",
      nextActionOn: "2026-01-05",
      tagIds: [ids.tag],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ stage: "new", ownerId: ids.sec, tags: [{ name: "Entreprise" }] });
    ids.youssef = created.body.id;
    expect((await h.call("POST", "/api/prospects", secretariat, { name: "Sans contact", source: "phone" })).body.code).toBe("prospect_contact_required");
    expect((await h.call("GET", "/api/prospects", accountant)).status).toBe(403);
    const list = await h.call("GET", "/api/prospects?due=true", secretariat);
    expect(list.body.items.map((p: { id: string }) => p.id)).toEqual([ids.youssef]);
    expect(list.body.due).toBe(1);
    expect((await h.call("GET", `/api/prospects?tagId=${ids.tag}`, secretariat)).body.items).toHaveLength(1);
  });

  it("turns a website request into a prospect once and marks the request handled", async () => {
    const from = await h.call("POST", `/api/prospects/from-lead/${ids.lead}`, secretariat);
    expect(from.status).toBe(201);
    expect(from.body).toMatchObject({ name: "Leila Aurelle", source: "website", company: "Orbite Studio", siteLeadId: ids.lead });
    ids.leila = from.body.id;
    expect((await h.db.selectFrom("site_leads").select("status").where("id", "=", ids.lead).executeTakeFirstOrThrow()).status).toBe("handled");
    expect((await h.call("POST", `/api/prospects/from-lead/${ids.lead}`, secretariat)).body.code).toBe("lead_already_prospect");
    const detail = await h.call("GET", `/api/prospects/${ids.leila}`, secretariat);
    expect(detail.body.activities[0]).toMatchObject({ kind: "note", text: "Message du site : Bureau pour 4 personnes en janvier" });
  });

  it("follows the stages and logs each change", async () => {
    await h.call("POST", `/api/prospects/${ids.leila}/activities`, secretariat, { kind: "call", text: "Visite fixée jeudi" });
    await h.call("POST", `/api/prospects/${ids.leila}/stage`, secretariat, { stage: "visit" });
    expect((await h.call("POST", `/api/prospects/${ids.youssef}/stage`, secretariat, { stage: "lost" })).status).toBe(400);
    const lost = await h.call("POST", `/api/prospects/${ids.youssef}/stage`, secretariat, { stage: "lost", lostReason: "Trop loin" });
    expect(lost.body).toMatchObject({ stage: "lost", lostReason: "Trop loin" });
    const detail = await h.call("GET", `/api/prospects/${ids.leila}`, secretariat);
    expect(detail.body.activities.map((a: { kind: string; text: string }) => [a.kind, a.text])).toEqual([
      ["stage", "Nouveau → Visite"],
      ["call", "Visite fixée jeudi"],
      ["note", "Message du site : Bureau pour 4 personnes en janvier"],
    ]);
    const counts = (await h.call("GET", "/api/prospects?stage=all", secretariat)).body.counts;
    expect(counts).toMatchObject({ visit: 1, lost: 1, new: 0 });
  });

  it("signs a prospect up as a coworking client or a student", async () => {
    const won = await h.call("POST", `/api/prospects/${ids.leila}/convert`, secretariat, { target: "member" });
    expect(won.status).toBe(201);
    expect(won.body).toMatchObject({ stage: "won", memberId: won.body.created.member_id });
    const member = await h.db
      .selectFrom("members")
      .select(["first_name", "last_name", "email", "kind"])
      .where("id", "=", won.body.memberId)
      .executeTakeFirstOrThrow();
    expect(member).toEqual({ first_name: "Leila", last_name: "Aurelle", email: "leila@orbite.test", kind: "member" });
    expect((await h.call("POST", `/api/prospects/${ids.leila}/convert`, secretariat, { target: "member" })).body.code).toBe("prospect_won");
    expect((await h.call("POST", `/api/prospects/${ids.leila}/stage`, secretariat, { stage: "new" })).body.code).toBe("prospect_won");

    const sami = await h.call("POST", "/api/prospects", secretariat, { name: "Sami", email: "leila@orbite.test", source: "referral" });
    expect((await h.call("POST", `/api/prospects/${sami.body.id}/convert`, secretariat, { target: "member" })).body.code).toBe("email_taken");
    expect((await h.call("POST", `/api/prospects/${sami.body.id}/convert`, secretariat, { target: "student" })).body.code).toBe("name_incomplete");
    await h.call("PATCH", `/api/prospects/${sami.body.id}`, secretariat, { name: "Sami Orbite" });
    const student = await h.call("POST", `/api/prospects/${sami.body.id}/convert`, secretariat, { target: "student" });
    expect(student.body.studentId).toBeTruthy();
  });
});
