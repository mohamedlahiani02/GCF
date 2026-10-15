import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, RecordingMailer, type Harness } from "./harness.js";

let h: Harness;
let admin: string;
let secretariat: string;
const mailer = new RecordingMailer();
const ids: Record<string, string> = {};

const account = async (studentId: string) => (await h.call("GET", `/api/students/${studentId}/account`, secretariat)).body;
const byLabel = (installments: { label: string }[], fragment: string) => installments.find((i) => i.label.includes(fragment)) as any;

beforeAll(async () => {
  h = await createHarness({ mailer });
  await h.createUser("admin", "admin@pay.tn");
  await h.createUser("secretariat", "sec@pay.tn");
  admin = await h.login("admin@pay.tn");
  secretariat = await h.login("sec@pay.tn");
  const subject = (await h.call("POST", "/api/catalogue/subjects", admin, { name: "Anglais" })).body.id;
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
  const teacher2 = (
    await h.call("POST", "/api/instructors", admin, {
      firstName: "Sami",
      lastName: "Haddad",
      kind: "teacher",
      employment: "salaried",
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
  const group = (name: string, instructorId: string, extra: Record<string, unknown> = {}) =>
    h.call("POST", "/api/groups", secretariat, {
      kind: "study",
      studyId: study,
      name,
      instructorId,
      startDate: "2026-09-01",
      endDate: "2026-12-31",
      slots: [],
      ...extra,
    });
  ids.gA = (await group("Groupe A", teacher)).body.id;
  ids.gB = (await group("Groupe B", teacher2, { priceOverride: 38_000 })).body.id;
  const training = (
    await h.call("POST", "/api/catalogue/trainings", admin, {
      title: "Anglais professionnel",
      durationHours: 30,
      price: 100_000,
      capacity: 10,
      paymentModes: "full",
    })
  ).body.id;
  const session = (await h.call("POST", `/api/catalogue/trainings/${training}/sessions`, admin, { name: "S1", startDate: "2026-10-01", endDate: "2026-12-15" }))
    .body.id;
  ids.gT = (
    await h.call("POST", "/api/groups", secretariat, {
      kind: "training",
      trainingSessionId: session,
      name: "Groupe pro",
      instructorId: teacher2,
      startDate: "2026-10-01",
      endDate: "2026-12-15",
      slots: [],
    })
  ).body.id;

  ids.amira = (await h.call("POST", "/api/students", secretariat, { firstName: "Amira", lastName: "Chebbi", receiptEmail: "amira@example.tn" })).body.id;
  ids.rim = (await h.call("POST", "/api/students", secretariat, { firstName: "Rim", lastName: "Jlassi", email: "rim@example.tn" })).body.id;
  for (const s of ["amira", "rim"]) {
    await h.call("POST", "/api/enrolments", secretariat, {
      studentId: ids[s],
      groupId: ids.gA,
      effectiveDate: "2026-09-01",
      paymentMode: "monthly",
      firstDueDate: "2026-09-05",
    });
  }
});

afterAll(async () => {
  await h.close();
});

describe("collecting a payment", () => {
  it("shows the schedule with the amount due and no credit", async () => {
    const a = await account(ids.amira);
    expect(a.totals).toEqual({ due: 160_000, credit: 0, pendingDiscounts: 0 });
    expect(a.installments.map((i: { state: string }) => i.state)).toEqual(["overdue", "overdue", "upcoming", "upcoming"]);
  });

  it("previews the allocation: checked instalments first, then the oldest", async () => {
    const octobre = byLabel((await account(ids.amira)).installments, "octobre");
    const preview = await h.call("POST", "/api/payments/preview", secretariat, { studentId: ids.amira, amount: 50_000, installmentIds: [octobre.id] });
    expect(preview.status).toBe(200);
    expect(preview.body.lines.map((l: { label: string; amount: number }) => [l.label.split(", ")[1], l.amount])).toEqual([
      ["octobre 2026", 40_000],
      ["septembre 2026", 10_000],
    ]);
    expect(preview.body.advance).toBe(0);
    expect(await h.db.selectFrom("payments").select("id").execute()).toHaveLength(0);
  });

  it("records the payment with a numbered receipt", async () => {
    const octobre = byLabel((await account(ids.amira)).installments, "octobre");
    const res = await h.call("POST", "/api/payments", secretariat, { studentId: ids.amira, amount: 50_000, method: "cash", installmentIds: [octobre.id] });
    expect(res.status).toBe(201);
    expect(res.body.receipt.number).toBe("REC-2026-000001");
    expect(res.body.after).toEqual({ due: 110_000, credit: 0, pendingDiscounts: 0 });
    ids.paymentA = res.body.paymentId;
    ids.receiptA = res.body.receipt.id;
  });

  it("turns money beyond what is due into a credit, explained in the response", async () => {
    const res = await h.call("POST", "/api/payments", secretariat, { studentId: ids.amira, amount: 150_000, method: "transfer", reference: "VIR-123" });
    expect(res.status).toBe(201);
    expect(res.body.advance).toBe(40_000);
    expect(res.body.after).toEqual({ due: 0, credit: 40_000, pendingDiscounts: 0 });
    expect(res.body.receipt.number).toBe("REC-2026-000002");
  });

  it("uses the credit automatically on a new enrolment", async () => {
    const res = await h.call("POST", "/api/enrolments", secretariat, {
      studentId: ids.amira,
      groupId: ids.gT,
      effectiveDate: "2026-10-01",
      paymentMode: "full",
    });
    expect(res.status).toBe(201);
    expect((await account(ids.amira)).totals).toEqual({ due: 60_000, credit: 0, pendingDiscounts: 0 });
  });

  it("re-opens what a bounced cheque had paid", async () => {
    const res = await h.call("POST", "/api/payments", secretariat, {
      studentId: ids.amira,
      amount: 60_000,
      method: "cheque",
      cheque: { number: "004871", bank: "BIAT" },
    });
    expect(res.status).toBe(201);
    expect(res.body.after.due).toBe(0);
    const bounced = await h.call("POST", `/api/payments/${res.body.paymentId}/cheque-status`, secretariat, {
      status: "bounced",
      reason: "Provision insuffisante",
    });
    expect(bounced.status).toBe(200);
    expect((await account(ids.amira)).totals.due).toBe(60_000);
    const again = await h.call("POST", `/api/payments/${res.body.paymentId}/cheque-status`, secretariat, { status: "cashed" });
    expect(again.status).toBe(409);
  });

  it("cancels a payment with a cancellation receipt instead of deleting it (admin only)", async () => {
    const bySecretariat = await h.call("POST", `/api/payments/${ids.paymentA}/cancel`, secretariat, { reason: "Erreur" });
    expect(bySecretariat.status).toBe(403);
    const res = await h.call("POST", `/api/payments/${ids.paymentA}/cancel`, admin, { reason: "Erreur de montant" });
    expect(res.status).toBe(200);
    expect(res.body.cancellationReceipt.number).toBe("REC-2026-000004");
    const a = await account(ids.amira);
    expect(a.totals.due).toBe(110_000);
    expect(a.payments.find((p: { id: string }) => p.id === ids.paymentA)).toMatchObject({ status: "cancelled", cancelReason: "Erreur de montant" });
  });

  it("keeps receipt numbers gap-free and receipts immutable", async () => {
    const receipts = await h.db.selectFrom("receipts").select(["sequence"]).orderBy("sequence").execute();
    expect(receipts.map((r) => r.sequence)).toEqual([1, 2, 3, 4]);
    await expect(sql`update receipts set number = 'X'`.execute(h.db)).rejects.toThrow(/immutable/);
    await expect(sql`delete from receipts`.execute(h.db)).rejects.toThrow(/immutable/);
  });

  it("refuses an allocation larger than the instalment, even written directly", async () => {
    const inst = byLabel((await account(ids.rim)).installments, "septembre");
    const pay = await h.call("POST", "/api/payments", secretariat, { studentId: ids.rim, amount: 1_000, method: "cash" });
    await expect(
      h.db.transaction().execute(async (trx) => {
        await trx
          .insertInto("allocations")
          .values({ centre_id: h.centreId, payment_id: pay.body.paymentId, installment_id: inst.id, amount: 50_000 })
          .execute();
      }),
    ).rejects.toThrow(/over/);
  });
});

describe("receipts", () => {
  it("prints the original once, then duplicates", async () => {
    const stored = await h.db.selectFrom("receipts").select("pdf").where("id", "=", ids.receiptA).executeTakeFirstOrThrow();
    const first = await h.app.inject({ method: "GET", url: `/api/receipts/${ids.receiptA}/pdf`, headers: { cookie: secretariat } });
    expect(first.statusCode).toBe(200);
    expect(Buffer.compare(first.rawPayload, stored.pdf)).toBe(0);
    const second = await h.app.inject({ method: "GET", url: `/api/receipts/${ids.receiptA}/pdf?format=A5`, headers: { cookie: secretariat } });
    expect(second.headers["content-disposition"]).toContain("duplicata");
    const detail = await h.call("GET", `/api/receipts/${ids.receiptA}`, secretariat);
    expect(detail.body.prints.map((p: { duplicate: boolean }) => p.duplicate)).toEqual([false, true]);
    expect(detail.body.cancelledBy.number).toBe("REC-2026-000004");
  });

  it("e-mails a receipt and logs every attempt, failed ones included", async () => {
    const ok = await h.call("POST", `/api/receipts/${ids.receiptA}/send`, secretariat, {});
    expect(ok.body).toMatchObject({ recipient: "amira@example.tn", status: "sent" });
    expect(mailer.sent.at(-1)!.attachments![0]!.filename).toBe("REC-2026-000001.pdf");
    mailer.failNext = true;
    const failed = await h.call("POST", `/api/receipts/${ids.receiptA}/send`, secretariat, {});
    expect(failed.body.status).toBe("failed");
    const list = await h.call("GET", "/api/receipts?q=000001", secretariat);
    expect(list.body.items[0]).toMatchObject({ number: "REC-2026-000001", status: "cancelled", dispatch: "failed" });
  });
});

describe("credit refunds", () => {
  it("refunds part of the credit and refuses more than the credit", async () => {
    const student = (await h.call("POST", "/api/students", secretariat, { firstName: "Nour", lastName: "Hamdi" })).body.id;
    await h.call("POST", "/api/payments", secretariat, { studentId: student, amount: 30_000, method: "cash" });
    const refund = await h.call("POST", "/api/payments/refunds", admin, { studentId: student, amount: 20_000, method: "cash", reason: "Départ" });
    expect(refund.status).toBe(201);
    expect((await account(student)).totals.credit).toBe(10_000);
    const tooMuch = await h.call("POST", "/api/payments/refunds", admin, { studentId: student, amount: 20_000, method: "cash", reason: "Départ" });
    expect(tooMuch.status).toBe(409);
  });
});

describe("postponements", () => {
  it("keeps a secretariat request pending until an admin approves it, with the original date kept", async () => {
    const nov = byLabel((await account(ids.rim)).installments, "novembre");
    const req = await h.call("POST", `/api/installments/${nov.id}/postpone`, secretariat, { toDate: "2026-11-20", reason: "Attente du virement familial" });
    expect(req.status).toBe(201);
    expect(req.body.status).toBe("pending");
    const duplicate = await h.call("POST", `/api/installments/${nov.id}/postpone`, secretariat, { toDate: "2026-11-25", reason: "x" });
    expect(duplicate.status).toBe(409);
    const decided = await h.call("POST", `/api/postponements/${req.body.id}/decision`, admin, { approve: true });
    expect(decided.status).toBe(200);
    const after = byLabel((await account(ids.rim)).installments, "novembre");
    expect(after).toMatchObject({ dueDate: "2026-11-20", originalDueDate: "2026-11-05", postponementCount: 1, state: "postponed" });
  });

  it("limits the number of postponements", async () => {
    const nov = byLabel((await account(ids.rim)).installments, "novembre");
    expect((await h.call("POST", `/api/installments/${nov.id}/postpone`, admin, { toDate: "2026-11-25", reason: "Deuxième report" })).status).toBe(201);
    const third = await h.call("POST", `/api/installments/${nov.id}/postpone`, admin, { toDate: "2026-11-30", reason: "Troisième" });
    expect(third.status).toBe(409);
    expect(third.body.code).toBe("too_many_postponements");
  });
});

describe("change of group and drop-out", () => {
  it("re-prices unpaid future instalments at the new group's tariff and keeps the history", async () => {
    const enrolment = (await h.call("GET", `/api/enrolments?studentId=${ids.rim}`, secretariat)).body.find((e: { groupId: string }) => e.groupId === ids.gA);
    const res = await h.call("POST", `/api/enrolments/${enrolment.id}/transfer`, secretariat, {
      newGroupId: ids.gB,
      effectiveDate: "2026-12-01",
      mode: "reprice",
      reason: "Conflit d'horaire",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ movedInstallments: 1, cancelledTotal: 40_000, issuedTotal: 38_000 });
    const a = await account(ids.rim);
    const dec = a.installments.filter((i: { label: string }) => i.label.includes("décembre"));
    expect(dec.map((i: { status: string; amount: number }) => [i.status, i.amount])).toEqual([
      ["cancelled", 40_000],
      ["open", 38_000],
    ]);
    expect(a.timeline.some((t: { type: string }) => t.type === "group_change")).toBe(true);
    const enrolments = (await h.call("GET", `/api/enrolments?studentId=${ids.rim}`, secretariat)).body;
    expect(enrolments.map((e: { status: string; endDate: string | null }) => [e.status, e.endDate])).toEqual([
      ["active", null],
      ["transferred", "2026-11-30"],
    ]);
  });

  it("drops out without refund and cancels unpaid instalments after the date", async () => {
    const enrolment = (await h.call("GET", `/api/enrolments?studentId=${ids.rim}`, secretariat)).body.find((e: { status: string }) => e.status === "active");
    const res = await h.call("POST", `/api/enrolments/${enrolment.id}/drop`, secretariat, { date: "2026-12-01", reason: "Déménagement" });
    expect(res.status).toBe(200);
    expect(res.body.cancelledInstallments).toBe(1);
  });
});

describe("reminders", () => {
  it("lists overdue instalments by student and e-mails reminders", async () => {
    const list = await h.call("GET", "/api/reminders", secretariat);
    expect(list.status).toBe(200);
    const rim = list.body.find((e: { studentId: string }) => e.studentId === ids.rim);
    expect(rim.recipient).toBe("rim@example.tn");
    expect(rim.items.map((i: { label: string }) => i.label.split(", ")[1])).toEqual(["septembre 2026", "octobre 2026"]);
    const sent = await h.call("POST", "/api/reminders/send", secretariat, { studentIds: [ids.rim] });
    expect(sent.body.results).toEqual([{ studentId: ids.rim, status: "sent" }]);
    expect(mailer.sent.at(-1)!.text).toContain("septembre 2026");
  });
});
