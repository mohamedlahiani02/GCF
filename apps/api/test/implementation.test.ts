import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiToken } from "../src/auth/apiTokens.js";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
let admin: string;
let consultant: string;
let secretariat: string;
const ids: Record<string, string> = {};

async function api(token: string | null, method: "GET" | "POST", url: string, payload?: unknown) {
  const res = await h.app.inject({
    method,
    url,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload === undefined ? {} : { "content-type": "application/json" }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

beforeAll(async () => {
  h = await createHarness();
  await h.setModules(["training", "coworking", "cafe"]);
  ids.admin = await h.createUser("admin", "admin@impl.test");
  admin = await h.login("admin@impl.test");
  const token = async (role: "implementation" | "secretariat") =>
    (
      await createApiToken(h.db, {
        centreId: h.centreId,
        name: `Jeton ${role}`,
        role,
        readOnly: false,
        sharePersonalData: false,
        expiresAt: null,
        createdBy: ids.admin,
      })
    ).token;
  consultant = await token("implementation");
  secretariat = await token("secretariat");
});

afterAll(async () => {
  await h.close();
});

describe("implementation access", () => {
  it("is reserved to an implementation token", async () => {
    expect((await api(null, "GET", "/api/implementation/imports")).status).toBe(401);
    expect((await api(secretariat, "GET", "/api/implementation/imports")).status).toBe(403);
    expect((await h.call("GET", "/api/implementation/imports", admin)).status).toBe(401);
    const catalogue = await api(consultant, "GET", "/api/implementation/imports");
    expect(catalogue.status).toBe(200);
    expect(catalogue.body.map((e: { entity: string }) => e.entity)).toEqual([
      "rooms",
      "subjects",
      "instructors",
      "studies",
      "trainings",
      "students",
      "renters",
      "companies",
      "members",
      "cafe-products",
    ]);
    const studies = catalogue.body.find((e: { entity: string }) => e.entity === "studies");
    expect(studies).toMatchObject({ dependsOn: ["subjects"], available: true });
    expect(studies.schema.required).toEqual(expect.arrayContaining(["subject", "name", "billingMode", "price"]));
  });

  it("never reaches money nor users", async () => {
    expect((await api(consultant, "GET", "/api/payments")).status).toBe(403);
    expect((await api(consultant, "GET", "/api/users")).status).toBe(403);
    expect((await api(consultant, "GET", "/api/cash/journal")).status).toBe(403);
  });
});

describe("imports", () => {
  it("previews without writing, then loads once", async () => {
    const subjects = [{ name: "Mathématiques" }, { name: "Anglais" }, { name: "mathématiques " }];
    const preview = await api(consultant, "POST", "/api/implementation/imports/subjects", { mode: "preview", rows: subjects });
    expect(preview.status).toBe(200);
    expect(preview.body.summary).toMatchObject({ create: 2, error: 1 });
    expect(preview.body.rows[2].errors).toEqual(["duplicate of line 1"]);
    expect(await h.db.selectFrom("subjects").select("id").where("centre_id", "=", h.centreId).execute()).toHaveLength(0);

    const applied = await api(consultant, "POST", "/api/implementation/imports/subjects", { mode: "apply", rows: subjects.slice(0, 2) });
    expect(applied.body.summary).toMatchObject({ created: 2 });
    const again = await api(consultant, "POST", "/api/implementation/imports/subjects", { mode: "apply", rows: subjects.slice(0, 2) });
    expect(again.body.summary).toMatchObject({ exists: 2, created: 0 });
    const audit = await h.db.selectFrom("audit_log").select(["action", "api_token_id"]).where("object_type", "=", "subject").execute();
    expect(audit).toHaveLength(2);
    expect(audit.every((a) => a.api_token_id !== null)).toBe(true);
  });

  it("resolves references written as names and reports unknown ones", async () => {
    const rows = [
      { subject: "Mathématiques", name: "Maths Bac", billingMode: "monthly", price: 120_000, absenceBilled: false, sessionsPerWeek: 2, capacity: 12 },
      { subject: "Physique", name: "Physique Bac", billingMode: "monthly", price: 120_000, absenceBilled: false, sessionsPerWeek: 2, capacity: 12 },
      { subject: "Anglais", name: "Anglais B1", billingMode: "per_session", price: -5, absenceBilled: false, sessionsPerWeek: 1, capacity: 8 },
    ];
    const result = await api(consultant, "POST", "/api/implementation/imports/studies", { mode: "apply", rows });
    expect(result.body.summary).toMatchObject({ created: 1, error: 2 });
    expect(result.body.rows[1].errors).toEqual(["unknown reference subject:Physique"]);
    expect(result.body.rows[2].errors[0]).toMatch(/^price/);

    const instructors = await api(consultant, "POST", "/api/implementation/imports/instructors", {
      mode: "apply",
      rows: [{ firstName: "Sana", lastName: "Valmont", kind: "teacher", employment: "freelance", email: "sana@impl.test", subjects: ["anglais"] }],
    });
    expect(instructors.body.summary).toMatchObject({ created: 1 });
    const links = await h.db.selectFrom("instructor_subjects").select("subject_id").where("instructor_id", "=", instructors.body.rows[0].id).execute();
    expect(links).toHaveLength(1);
  });

  it("reports the business rules the API applies when loading", async () => {
    await api(consultant, "POST", "/api/implementation/imports/companies", { mode: "apply", rows: [{ name: "Orbite Studio", taxId: "1234567/A" }] });
    const result = await api(consultant, "POST", "/api/implementation/imports/members", {
      mode: "apply",
      rows: [
        { kind: "member", firstName: "Lina", email: "lina@impl.test", company: "1234567/a" },
        { kind: "member", firstName: "Sans", lastName: "Courriel" },
      ],
    });
    expect(result.body.rows[0]).toMatchObject({ action: "created" });
    expect(result.body.rows[1]).toMatchObject({ action: "failed" });
    expect(result.body.rows[1].errors[0]).toMatch(/^422 email_required/);
    const member = await h.db.selectFrom("members").select("company_id").where("email", "=", "lina@impl.test").executeTakeFirstOrThrow();
    expect(member.company_id).not.toBeNull();
  });

  it("refuses an entity whose module is off", async () => {
    await h.setModules(["training"]);
    const result = await api(consultant, "POST", "/api/implementation/imports/cafe-products", {
      mode: "preview",
      rows: [{ name: "Café", price: 2000, trackStock: false }],
    });
    expect(result.status).toBe(403);
    await h.setModules(["training", "coworking", "cafe"]);
  });
});

describe("configuration packs", () => {
  it("exports settings without the centre's identity, previews and applies the differences", async () => {
    const exported = await api(consultant, "GET", "/api/implementation/pack");
    expect(exported.status).toBe(200);
    expect(exported.body.format).toBe("axelia.pack/1");
    expect(exported.body.sections.centre).not.toHaveProperty("name");
    expect(exported.body.sections.centre).toHaveProperty("overdueGraceDays");
    expect(exported.body.sections.coworking).toHaveProperty("approvalMode");
    expect(exported.body.sections.cafe).toHaveProperty("ticketPrefix");
    expect(Array.isArray(exported.body.sections.automations)).toBe(true);

    const pack = structuredClone(exported.body);
    pack.sections.centre.overdueGraceDays = 5;
    pack.sections.cafe.ticketPrefix = "BAR";
    const reminders = pack.sections.automations.find((a: { key: string }) => a.key === "overdue_reminders");
    reminders.mode = "propose";

    const preview = await api(consultant, "POST", "/api/implementation/pack", { mode: "preview", pack });
    expect(preview.body.changes.map((c: { section: string; field: string }) => `${c.section}.${c.field}`).sort()).toEqual([
      "automations.overdue_reminders",
      "cafe.ticketPrefix",
      "centre.overdueGraceDays",
    ]);
    expect((await h.db.selectFrom("centres").select("overdue_grace_days").where("id", "=", h.centreId).executeTakeFirstOrThrow()).overdue_grace_days).toBe(0);

    const applied = await api(consultant, "POST", "/api/implementation/pack", { mode: "apply", pack });
    expect(applied.body.failed).toEqual([]);
    expect(applied.body.applied.sort()).toEqual(["automations.overdue_reminders", "cafe", "centre"]);
    expect((await h.db.selectFrom("centres").select("overdue_grace_days").where("id", "=", h.centreId).executeTakeFirstOrThrow()).overdue_grace_days).toBe(5);
    expect((await api(consultant, "POST", "/api/implementation/pack", { mode: "preview", pack })).body.changes).toEqual([]);
  });

  it("rejects unknown fields and reports refused values", async () => {
    const unknown = await api(consultant, "POST", "/api/implementation/pack", {
      mode: "preview",
      pack: { format: "axelia.pack/1", sections: { centre: { name: "Autre centre" } } },
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body.details).toEqual({ fields: ["name"] });
    const refused = await api(consultant, "POST", "/api/implementation/pack", {
      mode: "apply",
      pack: { format: "axelia.pack/1", sections: { centre: { overdueGraceDays: 500 } } },
    });
    expect(refused.body.failed[0].section).toBe("centre");
    expect(refused.body.failed[0].error).toMatch(/^4\d\d/);
  });
});
