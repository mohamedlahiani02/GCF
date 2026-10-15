import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, ORIGIN, type Harness } from "./harness.js";

let h: Harness;
let adminId: string;
let admin: string;
let secretariat: string;
let accountant: string;

const json = (cookie: string) => ({ cookie, origin: ORIGIN });

beforeAll(async () => {
  h = await createHarness();
  adminId = await h.createUser("admin", "admin@test.tn");
  await h.createUser("secretariat", "secretariat@test.tn");
  await h.createUser("accountant", "compta@test.tn");
  admin = await h.login("admin@test.tn");
  secretariat = await h.login("secretariat@test.tn");
  accountant = await h.login("compta@test.tn");
});

afterAll(async () => {
  await h.close();
});

describe("authentication", () => {
  it("returns the user and the permissions of the role", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: secretariat } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.role).toBe("secretariat");
    expect(res.json().permissions).toEqual(["centre:read", "students:read", "students:write"]);
  });

  it("rejects state-changing requests from another origin", async () => {
    const res = await h.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: admin, origin: "https://evil.example" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("bad_origin");
  });

  it("locks the account after the configured number of failures", async () => {
    await h.createUser("secretariat", "victim@test.tn");
    for (let i = 0; i < 5; i += 1) {
      const res = await h.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: ORIGIN }, payload: { email: "victim@test.tn", password: "wrong-password" } });
      expect(res.statusCode).toBe(401);
    }
    const locked = await h.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: ORIGIN }, payload: { email: "victim@test.tn", password: "correct-horse-battery" } });
    expect(locked.statusCode).toBe(423);
  });

  it("gives the same answer for an unknown e-mail", async () => {
    const res = await h.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: ORIGIN }, payload: { email: "nobody@test.tn", password: "x" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("invalid_credentials");
  });
});

describe("role-based access", () => {
  it("hides user management and audit from the secretariat", async () => {
    expect((await h.app.inject({ method: "GET", url: "/api/users", headers: { cookie: secretariat } })).statusCode).toBe(403);
    expect((await h.app.inject({ method: "GET", url: "/api/audit-log", headers: { cookie: secretariat } })).statusCode).toBe(403);
  });

  it("lets the accountant read but not write students", async () => {
    expect((await h.app.inject({ method: "GET", url: "/api/students", headers: { cookie: accountant } })).statusCode).toBe(200);
    const res = await h.app.inject({ method: "POST", url: "/api/students", headers: json(accountant), payload: { firstName: "A", lastName: "B" } });
    expect(res.statusCode).toBe(403);
  });

  it("requires a session", async () => {
    expect((await h.app.inject({ method: "GET", url: "/api/students" })).statusCode).toBe(401);
  });
});

describe("students", () => {
  it("creates an adult student and records it in the audit log", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/students",
      headers: json(secretariat),
      payload: { firstName: "Amira", lastName: "Chebbi", birthDate: "2000-05-01", phone: "22 334 455", email: "" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().email).toBeNull();
    const audit = await h.db.selectFrom("audit_log").selectAll().where("object_id", "=", res.json().id).execute();
    expect(audit.map((a) => a.action)).toEqual(["student.created"]);
  });

  it("requires a guardian for a minor", async () => {
    const birthDate = `${new Date().getFullYear() - 15}-01-01`;
    const missing = await h.app.inject({ method: "POST", url: "/api/students", headers: json(secretariat), payload: { firstName: "Yassine", lastName: "Mejri", birthDate } });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().code).toBe("guardian_required");

    const ok = await h.app.inject({
      method: "POST",
      url: "/api/students",
      headers: json(secretariat),
      payload: { firstName: "Yassine", lastName: "Mejri", birthDate, guardianName: "Mme Mejri", guardianPhone: "22 111 222" },
    });
    expect(ok.statusCode).toBe(201);

    const removeGuardian = await h.app.inject({ method: "PATCH", url: `/api/students/${ok.json().id}`, headers: json(secretariat), payload: { guardianPhone: null } });
    expect(removeGuardian.statusCode).toBe(422);
  });

  it("rejects impossible dates and unknown fields", async () => {
    const bad = await h.app.inject({ method: "POST", url: "/api/students", headers: json(secretariat), payload: { firstName: "A", lastName: "B", birthDate: "2010-02-30" } });
    expect(bad.statusCode).toBe(400);
    const extra = await h.app.inject({ method: "POST", url: "/api/students", headers: json(secretariat), payload: { firstName: "A", lastName: "B", balance: 100 } });
    expect(extra.statusCode).toBe(400);
  });

  it("searches by name in either order and paginates", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/students?q=chebbi%20amira", headers: { cookie: secretariat } });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().items[0].lastName).toBe("Chebbi");
    const percent = await h.app.inject({ method: "GET", url: "/api/students?q=%25", headers: { cookie: secretariat } });
    expect(percent.json().total).toBe(0);
  });

  it("archives with a mandatory reason instead of deleting", async () => {
    const list = await h.app.inject({ method: "GET", url: "/api/students?q=amira", headers: { cookie: secretariat } });
    const id = list.json().items[0].id as string;
    const noReason = await h.app.inject({ method: "POST", url: `/api/students/${id}/archive`, headers: json(secretariat), payload: {} });
    expect(noReason.statusCode).toBe(400);
    const archived = await h.app.inject({ method: "POST", url: `/api/students/${id}/archive`, headers: json(secretariat), payload: { reason: "Abandon de la formation" } });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().status).toBe("archived");
    const entry = await h.db.selectFrom("audit_log").selectAll().where("object_id", "=", id).where("action", "=", "student.archived").executeTakeFirstOrThrow();
    expect(entry.reason).toBe("Abandon de la formation");
  });
});

describe("audit log and administration", () => {
  it("cannot be modified, even directly in the database", async () => {
    await expect(sql`update audit_log set action = 'tampered'`.execute(h.db)).rejects.toThrow(/append-only/);
    await expect(sql`delete from audit_log`.execute(h.db)).rejects.toThrow(/append-only/);
  });

  it("is readable by the accountant with filters", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/audit-log?objectType=student", headers: { cookie: accountant } });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThan(0);
    expect(res.json().items.every((i: { objectType: string }) => i.objectType === "student")).toBe(true);
  });

  it("keeps at least one active administrator", async () => {
    const res = await h.app.inject({ method: "PATCH", url: `/api/users/${adminId}`, headers: json(admin), payload: { active: false } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("last_admin");
  });

  it("signs out a user as soon as they are deactivated", async () => {
    const id = await h.createUser("secretariat", "leaving@test.tn");
    const cookie = await h.login("leaving@test.tn");
    const res = await h.app.inject({ method: "PATCH", url: `/api/users/${id}`, headers: json(admin), payload: { active: false } });
    expect(res.statusCode).toBe(200);
    expect((await h.app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } })).statusCode).toBe(401);
  });

  it("never returns password hashes", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/users", headers: { cookie: admin } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("argon2");
  });
});
