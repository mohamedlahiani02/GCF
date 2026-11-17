import { todayIn } from "@gcf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiToken } from "../src/auth/apiTokens.js";
import { overdueByStudent } from "../src/domain/reminders.js";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
let admin: string;
let accountant: string;
let consultant: string;
let secretariatToken: string;
const ids: Record<string, string> = {};
const today = todayIn("Africa/Tunis");
const range = () => `from=2026-01-01&to=${today}`;

async function api(token: string, method: "GET" | "POST", url: string, payload?: unknown) {
  const res = await h.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

const account = async (studentId: string) => (await h.call("GET", `/api/students/${studentId}/account`, admin)).body;

beforeAll(async () => {
  h = await createHarness();
  await h.setModules(["training", "coworking"]);
  ids.admin = await h.createUser("admin", "admin@open.test");
  await h.createUser("accountant", "compta@open.test");
  admin = await h.login("admin@open.test");
  accountant = await h.login("compta@open.test");
  const token = async (role: "implementation" | "secretariat") =>
    (await createApiToken(h.db, { centreId: h.centreId, name: role, role, readOnly: false, sharePersonalData: false, expiresAt: null, createdBy: ids.admin }))
      .token;
  consultant = await token("implementation");
  secretariatToken = await token("secretariat");
  ids.yasmine = (await h.call("POST", "/api/students", admin, { firstName: "Yasmine", lastName: "Ben Salem", email: "yasmine@open.test" })).body.id;
  ids.adam = (await h.call("POST", "/api/students", admin, { firstName: "Adam", lastName: "Trabelsi" })).body.id;
  ids.member = (await h.call("POST", "/api/coworking/members", admin, { kind: "member", firstName: "Lina", email: "lina@open.test" })).body.id;
});

afterAll(async () => {
  await h.close();
});

describe("opening debts", () => {
  it("are reserved to the consultant token and the administrator, and never in the future", async () => {
    const body = { payer: { kind: "student", id: ids.yasmine }, amount: 200_000, dueDate: "2026-09-30", label: "Impayé octobre" };
    expect((await api(secretariatToken, "POST", "/api/opening-balances/debts", body)).status).toBe(403);
    expect((await h.call("POST", "/api/opening-balances/debts", accountant, body)).status).toBe(403);
    expect((await api(consultant, "POST", "/api/opening-balances/debts", { ...body, dueDate: today })).body.code).toBe("not_in_the_past");
    expect((await api(consultant, "POST", "/api/opening-balances/debts", { ...body, payer: { kind: "member", id: ids.member } })).status).toBe(201);
    const created = await api(consultant, "POST", "/api/opening-balances/debts", body);
    expect(created.status).toBe(201);
    ids.debt = created.body.id;
    expect((await api(consultant, "GET", "/api/payments")).status).toBe(403);
  });

  it("appear in the student's account, the overdue list and the reminders, as an old overdue charge", async () => {
    const view = await account(ids.yasmine);
    expect(view.installments).toHaveLength(1);
    expect(view.installments[0]).toMatchObject({
      id: ids.debt,
      openingBalance: true,
      enrolmentId: null,
      amount: 200_000,
      remaining: 200_000,
      state: "overdue",
      dueDate: "2026-09-30",
    });
    expect(view.totals).toMatchObject({ due: 200_000 });
    const overdue = (await h.call("GET", "/api/payments/overdue", admin)).body.items;
    expect(overdue).toContainEqual(expect.objectContaining({ id: ids.debt, payerName: "Yasmine Ben Salem", remaining: 200_000 }));
    const reminders = await overdueByStudent(h.db, h.centreId);
    expect(reminders).toContainEqual(expect.objectContaining({ recipient: "yasmine@open.test", total: 200_000 }));
    const list = (await h.call("GET", "/api/students", admin)).body.items.find((s: { id: string }) => s.id === ids.yasmine);
    expect(JSON.stringify(list)).toContain("200000");
  });

  it("are not new revenue: left out of the invoiced figures, shown as collected once paid", async () => {
    const before = (await h.call("GET", `/api/reports/revenue?${range()}`, accountant)).body;
    expect(before.rows.find((r: { offer: string }) => r.offer.startsWith("Reprise"))).toBeUndefined();
    const unpaid = (await h.call("GET", `/api/reports/unpaid?${range()}`, accountant)).body;
    expect(JSON.stringify(unpaid.rows)).toContain("Impayé octobre");
    const paid = await h.call("POST", "/api/payments", admin, { studentId: ids.yasmine, amount: 80_000, method: "cash" });
    expect(paid.status).toBe(201);
    expect(paid.body.lines).toEqual([expect.objectContaining({ label: "Impayé octobre", amount: 80_000 })]);
    expect(paid.body.receipt.number).toBeTruthy();
    const after = (await h.call("GET", `/api/reports/revenue?${range()}`, accountant)).body;
    const reprise = after.rows.find((r: { offer: string }) => r.offer === "Reprise : soldes d'ouverture");
    expect(reprise).toMatchObject({ invoiced: 0, collected: 80_000 });
    expect((await account(ids.yasmine)).installments[0]).toMatchObject({ paid: 80_000, remaining: 120_000, state: "overdue" });
  });

  it("can be postponed like any overdue charge", async () => {
    const postponed = await h.call("POST", `/api/installments/${ids.debt}/postpone`, admin, { toDate: "2026-10-10", reason: "Accord avec la famille" });
    expect(postponed.status).toBe(201);
    expect((await account(ids.yasmine)).installments[0]).toMatchObject({ dueDate: "2026-10-10", postponementCount: 1 });
    expect((await account(ids.yasmine)).postponements).toHaveLength(1);
  });

  it("belong to a coworking member as well, and need their module", async () => {
    const lina = await h.call("GET", `/api/coworking/members/${ids.member}`, admin);
    expect(lina.status).toBe(200);
    const overdue = (await h.call("GET", "/api/payments/overdue", admin)).body.items;
    expect(overdue).toContainEqual(expect.objectContaining({ memberId: ids.member, payerName: "Lina", remaining: 200_000 }));
    await h.setModules(["coworking"]);
    const refused = await api(consultant, "POST", "/api/opening-balances/debts", {
      payer: { kind: "student", id: ids.adam },
      amount: 1000,
      dueDate: "2026-10-01",
    });
    expect(refused.body.code).toBe("module_not_enabled");
    await h.setModules(["training", "coworking"]);
  });
});

describe("opening advances", () => {
  it("are received as ordinary payments with their receipt and pay the older debts first", async () => {
    await api(consultant, "POST", "/api/opening-balances/debts", {
      payer: { kind: "student", id: ids.adam },
      amount: 100_000,
      dueDate: "2026-09-30",
      label: "Impayé septembre",
    });
    const advance = await api(consultant, "POST", "/api/opening-balances/advances", {
      payer: { kind: "student", id: ids.adam },
      amount: 150_000,
      method: "transfer",
      reference: "Ancien système n°42",
    });
    expect(advance.status).toBe(201);
    expect(advance.body.receipt.number).toMatch(/^REC-/);
    expect(advance.body.lines).toEqual([expect.objectContaining({ label: "Impayé septembre", amount: 100_000 })]);
    expect(advance.body.advance).toBe(50_000);
    const view = await account(ids.adam);
    expect(view.totals).toMatchObject({ due: 0, credit: 50_000 });
    expect(view.payments[0]).toMatchObject({ amount: 150_000, method: "transfer" });
  });

  it("need a reference, a cheque number and bank for a cheque, and the cash to be open", async () => {
    const base = { payer: { kind: "student", id: ids.adam }, amount: 1000, method: "transfer" };
    expect((await api(consultant, "POST", "/api/opening-balances/advances", base)).status).toBe(400);
    expect((await api(consultant, "POST", "/api/opening-balances/advances", { ...base, method: "cheque", reference: "x" })).status).toBe(400);
    expect((await api(consultant, "POST", "/api/opening-balances/advances", { ...base, reference: "ok" })).status).toBe(201);
  });
});

describe("loading opening balances by file", () => {
  it("previews, loads once, reconciles the totals and refuses an ambiguous name", async () => {
    await h.call("POST", "/api/students", admin, { firstName: "Rim", lastName: "Gharbi", phone: "55 000 001" });
    await h.call("POST", "/api/students", admin, { firstName: "Rim", lastName: "Gharbi", phone: "55 000 002" });
    const rows = [
      { kind: "student", person: "adam trabelsi", amount: 30_000, dueDate: "2026-08-31", label: "Impayé août" },
      { kind: "member", person: "lina@open.test", amount: 45_000, dueDate: "2026-08-31" },
      { kind: "student", person: "Rim Gharbi", amount: 10_000, dueDate: "2026-08-31" },
      { kind: "student", person: "adam trabelsi", amount: 30_000, dueDate: "2026-08-31", label: "Impayé août" },
    ];
    const preview = await api(consultant, "POST", "/api/implementation/imports/opening-debts", { mode: "preview", rows });
    expect(preview.body.summary).toMatchObject({ create: 2, error: 2 });
    expect(preview.body.rows[2].errors[0]).toMatch(/^ambiguous reference student:Rim Gharbi/);
    expect(preview.body.rows[3].errors).toEqual(["duplicate of line 1"]);
    expect(preview.body.totals).toMatchObject({ create: 75_000 });

    const applied = await api(consultant, "POST", "/api/implementation/imports/opening-debts", { mode: "apply", rows: rows.slice(0, 2) });
    expect(applied.body.summary).toMatchObject({ created: 2 });
    expect(applied.body.totals).toMatchObject({ created: 75_000 });
    const again = await api(consultant, "POST", "/api/implementation/imports/opening-debts", { mode: "apply", rows: rows.slice(0, 2) });
    expect(again.body.summary).toMatchObject({ exists: 2, created: 0 });
    expect(again.body.totals).toMatchObject({ exists: 75_000 });
  });

  it("loads advances once, keyed by their reference in the previous system", async () => {
    const rows = [{ kind: "member", person: "Lina", amount: 20_000, method: "transfer", reference: "A-7" }];
    const first = await api(consultant, "POST", "/api/implementation/imports/opening-advances", { mode: "apply", rows });
    expect(first.body.rows[0]).toMatchObject({ action: "created" });
    const again = await api(consultant, "POST", "/api/implementation/imports/opening-advances", { mode: "preview", rows });
    expect(again.body.summary).toMatchObject({ exists: 1 });
    const payment = await h.db.selectFrom("payments").select(["amount", "reference"]).where("id", "=", first.body.rows[0].id).executeTakeFirstOrThrow();
    expect(payment).toEqual({ amount: 20_000, reference: "A-7" });
  });
});
