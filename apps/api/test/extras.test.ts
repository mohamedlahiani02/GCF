import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
let admin: string;
let secretariat: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  h = await createHarness();
  await h.createUser("admin", "admin@x.tn");
  await h.createUser("secretariat", "sec@x.tn");
  admin = await h.login("admin@x.tn");
  secretariat = await h.login("sec@x.tn");
  const subject = (await h.call("POST", "/api/catalogue/subjects", admin, { name: "Anglais" })).body.id;
  const teacher = (
    await h.call("POST", "/api/instructors", admin, {
      firstName: "Sana",
      lastName: "Ben Salah",
      kind: "teacher",
      employment: "contractor",
      subjectIds: [],
      availability: [],
    })
  ).body.id;
  const study = (
    await h.call("POST", "/api/catalogue/studies", admin, {
      subjectId: subject,
      name: "Anglais",
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
      name: "Anglais A",
      instructorId: teacher,
      startDate: "2026-09-01",
      endDate: "2026-12-31",
      slots: [],
    })
  ).body.id;
  ids.student = (await h.call("POST", "/api/students", secretariat, { firstName: "Amira", lastName: "Chebbi", phone: "22334455" })).body.id;
  await h.call("POST", "/api/enrolments", secretariat, {
    studentId: ids.student,
    groupId: ids.group,
    effectiveDate: "2026-09-01",
    paymentMode: "monthly",
    firstDueDate: "2026-10-05",
  });
  ids.receipt = (await h.call("POST", "/api/payments", secretariat, { studentId: ids.student, amount: 30_000, method: "cash" })).body.receipt.number;
});

afterAll(async () => {
  await h.close();
});

describe("centre settings", () => {
  it("changes counting, postponement, receipt and opening settings, admin only", async () => {
    const denied = await h.call("PATCH", "/api/centre", secretariat, { maxPostponements: 3 });
    expect(denied.status).toBe(403);
    const res = await h.call("PATCH", "/api/centre", admin, {
      countJustifiedAsPresent: true,
      maxPostponements: 3,
      receiptPrefix: "CAF",
      openFrom: "07:30",
      openWeekdays: [6, 1, 2, 2],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      countJustifiedAsPresent: true,
      maxPostponements: 3,
      receiptPrefix: "CAF",
      openFrom: "07:30",
      openTo: "20:00",
      openWeekdays: [1, 2, 6],
    });
    const invalid = await h.call("PATCH", "/api/centre", admin, { openFrom: "21:00" });
    expect(invalid.status).toBe(422);
  });
});

describe("lists and search", () => {
  it("shows active groups, amount due and last payment in the student list", async () => {
    const res = await h.call("GET", "/api/students", secretariat);
    expect(res.body.items[0]).toMatchObject({ lastName: "Chebbi", activeGroups: ["Anglais A"], due: 90_000 });
    expect(res.body.items[0].lastPaymentAt).not.toBeNull();
  });

  it("finds students, instructors and receipts from the sidebar", async () => {
    const byName = await h.call("GET", "/api/search?q=chebbi", secretariat);
    expect(byName.body.students.map((s: { lastName: string }) => s.lastName)).toEqual(["Chebbi"]);
    const byReceipt = await h.call("GET", `/api/search?q=${ids.receipt.slice(-6)}`, secretariat);
    expect(byReceipt.body.receipts.map((r: { number: string }) => r.number)).toEqual([ids.receipt]);
    const byTeacher = await h.call("GET", "/api/search?q=sana", secretariat);
    expect(byTeacher.body.instructors).toHaveLength(1);
  });

  it("summarises a group's money for a month", async () => {
    const res = await h.call("GET", `/api/groups/${ids.group}/finance?month=2026-10`, secretariat);
    expect(res.body).toEqual({ month: "2026-10", invoiced: 40_000, collected: 30_000, unpaid: 10_000, postponed: 0 });
  });
});

describe("screens support", () => {
  it("views a receipt without counting a print", async () => {
    const list = await h.call("GET", "/api/receipts", secretariat);
    const id = list.body.items[0].id;
    const view = await h.app.inject({ method: "GET", url: `/api/receipts/${id}/view`, headers: { cookie: secretariat } });
    expect(view.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await h.call("GET", `/api/receipts/${id}`, secretariat)).body.prints).toHaveLength(0);
  });

  it("lists what waits for an admin decision", async () => {
    const account = (await h.call("GET", `/api/students/${ids.student}/account`, secretariat)).body;
    const open = account.installments.find((i: { state: string }) => i.state === "upcoming");
    await h.call("POST", `/api/installments/${open.id}/postpone`, secretariat, { toDate: "2026-12-20", reason: "Attente" });
    const approvals = await h.call("GET", "/api/approvals", admin);
    expect(approvals.body.postponements).toEqual([expect.objectContaining({ studentName: "Amira Chebbi", reason: "Attente" })]);
    expect(approvals.body.discounts).toEqual([]);
  });

  it("gives a renter's account", async () => {
    const renter = (await h.call("POST", "/api/renters", secretariat, { name: "Société Medis" })).body.id;
    const res = await h.call("GET", `/api/renters/${renter}/account`, secretariat);
    expect(res.body).toMatchObject({ renter: { name: "Société Medis" }, totals: { due: 0, credit: 0 }, installments: [], payments: [] });
  });
});
