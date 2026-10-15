import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
let admin: string;
let secretariat: string;
let accountant: string;
let today: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  h = await createHarness();
  await h.createUser("admin", "admin@cash.tn");
  await h.createUser("secretariat", "sec@cash.tn");
  await h.createUser("accountant", "compta@cash.tn");
  admin = await h.login("admin@cash.tn");
  secretariat = await h.login("sec@cash.tn");
  accountant = await h.login("compta@cash.tn");
  today = (await sql<{ d: string }>`select to_char(now() at time zone 'Africa/Tunis', 'YYYY-MM-DD') as d`.execute(h.db)).rows[0]!.d;
  const subject = (await h.call("POST", "/api/catalogue/subjects", admin, { name: "Français" })).body.id;
  const teacher = (
    await h.call("POST", "/api/instructors", admin, {
      firstName: "Ines",
      lastName: "Gharbi",
      kind: "teacher",
      employment: "salaried",
      subjectIds: [],
      availability: [],
    })
  ).body.id;
  const study = (
    await h.call("POST", "/api/catalogue/studies", admin, {
      subjectId: subject,
      name: "Français",
      billingMode: "monthly",
      price: 40_000,
      absenceBilled: true,
      sessionsPerWeek: 1,
      capacity: 10,
    })
  ).body.id;
  ids.group = (
    await h.call("POST", "/api/groups", secretariat, {
      kind: "study",
      studyId: study,
      name: "Français A",
      instructorId: teacher,
      startDate: "2026-09-01",
      endDate: "2026-12-31",
      slots: [],
    })
  ).body.id;
  for (const [key, name] of [
    ["a", "Amira"],
    ["b", "Omar"],
  ] as const) {
    ids[key] = (await h.call("POST", "/api/students", secretariat, { firstName: name, lastName: "Caisse" })).body.id;
    await h.call("POST", "/api/enrolments", secretariat, {
      studentId: ids[key],
      groupId: ids.group,
      effectiveDate: "2026-09-01",
      paymentMode: "monthly",
      firstDueDate: "2026-09-05",
    });
  }
  await h.call("POST", "/api/payments", secretariat, { studentId: ids.a, amount: 100_000, method: "cash" });
  await h.call("POST", "/api/payments", secretariat, { studentId: ids.a, amount: 50_000, method: "card" });
  await h.call("POST", "/api/payments", secretariat, { studentId: ids.b, amount: 30_000, method: "transfer" });
});

afterAll(async () => {
  await h.close();
});

describe("cash", () => {
  it("lists the day's money by method", async () => {
    const res = await h.call("GET", `/api/cash/journal?date=${today}`, secretariat);
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ cash: 100_000, cheque: 0, card: 50_000, transfer: 30_000 });
    expect(res.body.expectedCash).toBe(100_000);
    expect(res.body.payments).toHaveLength(3);
  });

  it("requires a comment for a difference and lets only the accountant or admin close", async () => {
    expect((await h.call("POST", "/api/cash/closings", secretariat, { day: today, countedCash: 100_000 })).status).toBe(403);
    const noComment = await h.call("POST", "/api/cash/closings", accountant, { day: today, countedCash: 99_000 });
    expect(noComment.status).toBe(422);
    const closed = await h.call("POST", "/api/cash/closings", accountant, { day: today, countedCash: 99_000, comment: "Monnaie rendue en trop" });
    expect(closed.status).toBe(201);
    expect(closed.body).toMatchObject({ expectedCash: 100_000, countedCash: 99_000, difference: -1_000 });
    expect((await h.call("POST", "/api/cash/closings", admin, { day: today, countedCash: 100_000 })).status).toBe(409);
  });

  it("locks the closed day: no new payment, no change to the closing", async () => {
    const res = await h.call("POST", "/api/payments", secretariat, { studentId: ids.b, amount: 10_000, method: "cash" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("cash_closed");
    await expect(sql`update cash_closings set counted_cash = 100000`.execute(h.db)).rejects.toThrow(/locked/);
    const history = await h.call("GET", "/api/cash/closings", secretariat);
    expect(history.body[0]).toMatchObject({ day: today, difference: -1_000, comment: "Monnaie rendue en trop" });
  });
});

describe("reports", () => {
  it("offers each role its reports only", async () => {
    const forSecretariat = (await h.call("GET", "/api/reports", secretariat)).body.map((r: { name: string }) => r.name);
    expect(forSecretariat).toEqual(["unpaid", "attendance", "rooms"]);
    const forAccountant = (await h.call("GET", "/api/reports", accountant)).body.map((r: { name: string }) => r.name);
    expect(forAccountant).toEqual(["unpaid", "revenue", "collections", "payroll", "attendance", "rooms"]);
    expect((await h.call("GET", `/api/reports/revenue?from=2026-09-01&to=2026-12-31`, secretariat)).status).toBe(403);
  });

  it("lists overdue instalments", async () => {
    const res = await h.call("GET", `/api/reports/unpaid?from=2026-09-01&to=${today}`, secretariat);
    expect(res.status).toBe(200);
    // Omar paid 30 of September (40) and nothing for October; Amira's 150 paid September, October, November.
    expect(res.body.rows.map((r: { payer: string; remaining: number }) => [r.payer, r.remaining])).toEqual([
      ["Caisse Omar", 10_000],
      ["Caisse Omar", 40_000],
    ]);
  });

  it("splits invoiced and collected revenue by offer", async () => {
    const res = await h.call("GET", `/api/reports/revenue?from=2026-09-01&to=2026-12-31`, accountant);
    expect(res.body.rows).toEqual([{ offer: "Cours particulier : Français", invoiced: 320_000, collected: 180_000 }]);
  });

  it("exports to Excel, CSV and PDF", async () => {
    const xlsx = await h.app.inject({ method: "GET", url: `/api/reports/collections?from=${today}&to=${today}&format=xlsx`, headers: { cookie: accountant } });
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe("PK");
    const csv = await h.app.inject({ method: "GET", url: `/api/reports/collections?from=${today}&to=${today}&format=csv`, headers: { cookie: accountant } });
    expect(csv.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(csv.body).toContain("Espèces;");
    expect(csv.body).toContain("100,000");
    const pdf = await h.app.inject({ method: "GET", url: `/api/reports/rooms?from=${today}&to=${today}&format=pdf`, headers: { cookie: secretariat } });
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    const exported = await h.db.selectFrom("audit_log").select("object_id").where("action", "=", "report.exported").execute();
    expect(exported).toHaveLength(3);
  });
});

describe("dashboard", () => {
  it("shows the financial section to the accountant and the operational one to the secretariat", async () => {
    const forAccountant = await h.call("GET", "/api/dashboard", accountant);
    expect(forAccountant.body.sections).toEqual({ financial: true, operational: false });
    expect(forAccountant.body.financial).toMatchObject({ collectionsToday: 180_000, unpaidTotal: 50_000, unpaidPayers: 1 });
    expect(forAccountant.body.financial.series).toHaveLength(14);
    expect(forAccountant.body.financial.series.at(-1)).toEqual({ bucket: today, total: 180_000 });
    const forSecretariat = await h.call("GET", "/api/dashboard", secretariat);
    expect(forSecretariat.body.sections).toEqual({ financial: false, operational: true });
    expect(forSecretariat.body.operational.todo.overdueInstallments).toEqual({ count: 2, total: 50_000 });
    expect(forSecretariat.body.operational.todo.remindersToSend).toBe(1);
    const monthly = await h.call("GET", "/api/dashboard?granularity=month", admin);
    expect(monthly.body.financial.series).toHaveLength(12);
    expect(monthly.body.sections).toEqual({ financial: true, operational: true });
  });
});
