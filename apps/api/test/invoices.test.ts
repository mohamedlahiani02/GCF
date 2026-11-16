import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, RecordingMailer, type Harness } from "./harness.js";

let h: Harness;
let admin: string;
let secretariat: string;
let accountant: string;
const mailer = new RecordingMailer();
const ids: Record<string, string> = {};

/** A coworking charge needs a source: each test charge is the price of a prepaid pack. */
async function insertCharge(memberId: string, label: string, amount: number, dueDate: string): Promise<string> {
  const pack = await h.db
    .insertInto("cw_packs")
    .values({
      centre_id: h.centreId,
      member_id: memberId,
      product_id: ids.product!,
      type_id: ids.type!,
      quota_kind: "bookings",
      quota: 10,
      price: amount,
      starts_on: dueDate,
      expires_on: "2027-12-31",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const row = await h.db
    .insertInto("installments")
    .values({
      centre_id: h.centreId,
      enrolment_id: null,
      member_id: memberId,
      cw_pack_id: pack.id,
      label,
      kind: "charge",
      amount,
      due_date: dueDate,
      original_due_date: dueDate,
      discount_status: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

beforeAll(async () => {
  h = await createHarness({ mailer });
  await h.setModules(["training", "coworking"]);
  await h.createUser("admin", "admin@fa.test");
  await h.createUser("secretariat", "sec@fa.test");
  await h.createUser("accountant", "compta@fa.test");
  admin = await h.login("admin@fa.test");
  secretariat = await h.login("sec@fa.test");
  accountant = await h.login("compta@fa.test");
  await h.db.updateTable("centres").set({ tax_id: "1234567/A/M/000", address: "12 rue de Carthage, Tunis" }).where("id", "=", h.centreId).execute();
  ids.company = (
    await h.db
      .insertInto("companies")
      .values({ centre_id: h.centreId, name: "Orbite Studio", tax_id: "7654321/B/A/000", address: "4 avenue Habib Bourguiba", email: "compta@orbite.test" })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  ids.person = (
    await h.db
      .insertInto("members")
      .values({ centre_id: h.centreId, kind: "member", first_name: "Selma", last_name: "Aurelle", email: "selma@fa.test" })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  ids.employee = (
    await h.db
      .insertInto("members")
      .values({
        centre_id: h.centreId,
        kind: "member",
        first_name: "Karim",
        last_name: "Valmont",
        email: "karim@fa.test",
        company_id: ids.company,
        company_role: "admin",
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  ids.type = (
    await h.db
      .insertInto("cw_resource_types")
      .values({ centre_id: h.centreId, name: "Open space", category: "hot_desk" })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  ids.product = (
    await h.db
      .insertInto("cw_pack_products")
      .values({ centre_id: h.centreId, name: "Carnet", type_id: ids.type, quota_kind: "bookings", quota: 10, validity_days: 90, price: 1_000 })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  ids.c1 = await insertCharge(ids.person, "Abonnement mensuel novembre", 120_000, "2026-11-05");
  ids.c2 = await insertCharge(ids.person, "Salle de réunion R1, 10/11/2026", 40_000, "2026-11-10");
  ids.c3 = await insertCharge(ids.employee, "Bureau privé B2, novembre", 595_000, "2026-11-01");
});

afterAll(async () => {
  await h.close();
});

describe("invoices", () => {
  it("lists what can be invoiced and issues numbered invoices", async () => {
    const open = await h.call("GET", `/api/invoices/uninvoiced?payerKind=member&payerId=${ids.person}`, secretariat);
    expect(open.body.map((c: { id: string }) => c.id).sort()).toEqual([ids.c1, ids.c2].sort());
    const first = await h.call("POST", "/api/invoices", secretariat, { payer: { kind: "member", id: ids.person }, installmentIds: [ids.c1, ids.c2] });
    expect(first.status).toBe(201);
    expect(first.body.number).toMatch(/^FA-\d{4}-00001$/);
    ids.inv1 = first.body.id;
    expect((await h.call("GET", `/api/invoices/uninvoiced?payerKind=member&payerId=${ids.person}`, secretariat)).body).toEqual([]);
    const again = await h.call("POST", "/api/invoices", secretariat, { payer: { kind: "member", id: ids.person }, installmentIds: [ids.c1] });
    expect(again.body.code).toBe("invoice_charge_unavailable");
    const foreign = await h.call("POST", "/api/invoices", secretariat, { payer: { kind: "member", id: ids.person }, installmentIds: [ids.c3] });
    expect(foreign.body.code).toBe("invoice_charge_unavailable");
    expect((await h.call("POST", "/api/invoices", accountant, { payer: { kind: "member", id: ids.person }, installmentIds: [ids.c3] })).status).toBe(403);

    const detail = await h.call("GET", `/api/invoices/${ids.inv1}`, accountant);
    expect(detail.body).toMatchObject({ kind: "invoice", total: 160_000, net: 160_000, tax: 0, taxBp: null, state: "unpaid", remaining: 160_000 });
    expect(detail.body.snapshot.buyer).toMatchObject({ name: "Selma Aurelle", company: false });
    const pdf = await h.app.inject({ method: "GET", url: `/api/invoices/${ids.inv1}/pdf`, headers: { cookie: accountant } });
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("invoices a company member to the company and splits the tax when the centre shows a rate", async () => {
    expect((await h.call("PATCH", "/api/centre", admin, { invoiceTaxBp: 1900 })).status).toBe(200);
    const issued = await h.call("POST", "/api/invoices", secretariat, { payer: { kind: "member", id: ids.employee }, installmentIds: [ids.c3] });
    ids.inv2 = issued.body.id;
    expect(issued.body.number).toMatch(/-00002$/);
    const detail = await h.call("GET", `/api/invoices/${ids.inv2}`, secretariat);
    expect(detail.body).toMatchObject({ total: 595_000, net: 500_000, tax: 95_000, taxBp: 1900 });
    expect(detail.body.snapshot.buyer).toMatchObject({ name: "Orbite Studio", company: true, taxId: "7654321/B/A/000" });
  });

  it("follows payments through the ledger", async () => {
    const paid = await h.call("POST", "/api/payments", secretariat, { memberId: ids.person, amount: 120_000, method: "cash", installmentIds: [ids.c1] });
    expect(paid.status).toBe(201);
    expect((await h.call("GET", `/api/invoices/${ids.inv1}`, secretariat)).body).toMatchObject({ paid: 120_000, remaining: 40_000 });
    await h.call("POST", "/api/payments", secretariat, { memberId: ids.person, amount: 40_000, method: "cash", installmentIds: [ids.c2] });
    expect((await h.call("GET", `/api/invoices/${ids.inv1}`, secretariat)).body).toMatchObject({ state: "paid", remaining: 0 });
    const list = await h.call("GET", "/api/invoices?state=unpaid", secretariat);
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([ids.inv2]);
    expect(list.body.totals).toEqual({ invoiced: 595_000, remaining: 595_000 });
  });

  it("e-mails the PDF and records the delivery", async () => {
    expect((await h.call("GET", "/api/invoices?state=unsent", secretariat)).body.items).toHaveLength(2);
    const sent = await h.call("POST", `/api/invoices/${ids.inv2}/send`, secretariat, { to: "compta@orbite.test" });
    expect(sent.body).toEqual({ status: "sent" });
    const message = mailer.sent.at(-1)!;
    expect(message.to).toBe("compta@orbite.test");
    expect(message.attachments?.[0]?.contentType).toBe("application/pdf");
    expect(message.text).toContain("595,000 TND");
    await h.call("POST", `/api/invoices/${ids.inv1}/delivered`, secretariat, { how: "Remise en main propre à l'accueil" });
    expect((await h.call("GET", "/api/invoices?state=unsent", secretariat)).body.items).toHaveLength(0);
    expect((await h.call("GET", `/api/invoices/${ids.inv2}`, secretariat)).body.dispatches).toHaveLength(1);
  });

  it("cancels an invoice only with a credit note, which frees its charges", async () => {
    expect((await h.call("POST", `/api/invoices/${ids.inv2}/credit`, secretariat, { reason: "Erreur de période" })).status).toBe(403);
    const credit = await h.call("POST", `/api/invoices/${ids.inv2}/credit`, admin, { reason: "Erreur de période" });
    expect(credit.status).toBe(201);
    expect(credit.body.number).toMatch(/^AV-\d{4}-00001$/);
    const note = await h.call("GET", `/api/invoices/${credit.body.id}`, admin);
    expect(note.body).toMatchObject({ kind: "credit_note", total: -595_000, net: -500_000, tax: -95_000, creditsInvoiceId: ids.inv2 });
    expect(note.body.snapshot.credits).toMatchObject({ reason: "Erreur de période" });
    expect((await h.call("GET", `/api/invoices/${ids.inv2}`, admin)).body).toMatchObject({
      status: "credited",
      state: "credited",
      creditNote: { id: credit.body.id },
    });
    expect((await h.call("POST", `/api/invoices/${ids.inv2}/credit`, admin, { reason: "Encore" })).body.code).toBe("invoice_already_credited");
    expect((await h.call("POST", `/api/invoices/${credit.body.id}/credit`, admin, { reason: "Encore" })).body.code).toBe("invoice_is_credit_note");
    const reissued = await h.call("POST", "/api/invoices", secretariat, { payer: { kind: "member", id: ids.employee }, installmentIds: [ids.c3] });
    expect(reissued.body.number).toMatch(/-00003$/);
  });

  it("keeps issued documents unchanged in the database", async () => {
    await expect(h.db.updateTable("invoices").set({ total: 1 }).where("id", "=", ids.inv1!).execute()).rejects.toThrow(/cannot be changed/);
    await expect(h.db.deleteFrom("invoices").where("id", "=", ids.inv1!).execute()).rejects.toThrow(/cannot be deleted/);
  });
});
