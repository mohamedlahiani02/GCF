import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
let admin: string;
let secretariat: string;
let accountant: string;
const ids: Record<string, string> = {};
const students: string[] = [];

beforeAll(async () => {
  h = await createHarness();
  await h.createUser("admin", "admin@paie.tn");
  await h.createUser("secretariat", "sec@paie.tn");
  await h.createUser("accountant", "compta@paie.tn");
  admin = await h.login("admin@paie.tn");
  secretariat = await h.login("sec@paie.tn");
  accountant = await h.login("compta@paie.tn");
  const subject = (await h.call("POST", "/api/catalogue/subjects", admin, { name: "Mathématiques" })).body.id;
  const teacher = (firstName: string, lastName: string, employment: string) =>
    h.call("POST", "/api/instructors", admin, { firstName, lastName, kind: "teacher", employment, subjectIds: [], availability: [] });
  ids.sana = (await teacher("Sana", "Ben Salah", "contractor")).body.id;
  ids.ines = (await teacher("Ines", "Gharbi", "salaried")).body.id;
  ids.study = (
    await h.call("POST", "/api/catalogue/studies", admin, {
      subjectId: subject,
      name: "Maths Bac",
      billingMode: "monthly",
      price: 40_000,
      absenceBilled: true,
      sessionsPerWeek: 1,
      capacity: 12,
    })
  ).body.id;
  ids.group = (
    await h.call("POST", "/api/groups", secretariat, {
      kind: "study",
      studyId: ids.study,
      name: "Groupe A",
      instructorId: ids.sana,
      startDate: "2026-09-01",
      endDate: "2026-12-31",
      slots: [{ weekday: 2, startTime: "14:00", endTime: "16:00" }],
    })
  ).body.id;
  ids.groupFr = (
    await h.call("POST", "/api/groups", secretariat, {
      kind: "study",
      studyId: ids.study,
      name: "Français B",
      instructorId: ids.ines,
      startDate: "2026-09-01",
      endDate: "2026-12-31",
      slots: [{ weekday: 4, startTime: "17:00", endTime: "18:30" }],
    })
  ).body.id;
  for (let i = 1; i <= 8; i += 1) {
    const id = (await h.call("POST", "/api/students", secretariat, { firstName: `Élève${i}`, lastName: "Maths" })).body.id;
    students.push(id);
    await h.call("POST", "/api/enrolments", secretariat, {
      studentId: id,
      groupId: ids.group,
      effectiveDate: "2026-09-01",
      paymentMode: "monthly",
      firstDueDate: "2026-09-05",
    });
    const pay = await h.call("POST", "/api/payments", secretariat, { studentId: id, amount: 40_000, method: "cash" });
    // Collections are counted on the day money is received; these fixtures were collected in September.
    await sql`update payments set received_at = '2026-09-10T09:00:00Z' where id = ${pay.body.paymentId}`.execute(h.db);
  }
  // 5 Tuesday sessions in September 2026; 6 absences out of 40 student-sessions = 85 % attendance.
  await h.call("POST", `/api/groups/${ids.group}/sessions/generate`, secretariat, { from: "2026-09-01", to: "2026-09-30" });
  const absences = [2, 2, 1, 1, 0];
  for (const [index, day] of ["01", "08", "15", "22", "29"].entries()) {
    const session = (await h.call("GET", `/api/sessions?date=2026-09-${day}`, secretariat)).body[0];
    const records = students.slice(0, absences[index]).map((studentId) => ({ studentId, status: "absent" }));
    if (records.length) await h.call("PUT", `/api/sessions/${session.id}/attendance`, secretariat, { records });
    expect((await h.call("POST", `/api/sessions/${session.id}/validate`, secretariat)).status).toBe(200);
  }
  await h.call("POST", `/api/groups/${ids.groupFr}/sessions/generate`, secretariat, { from: "2026-09-01", to: "2026-09-30" });
  const frSessions = await h.db.selectFrom("class_sessions").select("id").where("group_id", "=", ids.groupFr).orderBy("starts_at").execute();
  await h.call("POST", `/api/sessions/${frSessions[0]!.id}/cancel`, secretariat, { reason: "Absence de l'enseignante" });
  for (const s of frSessions.slice(1)) await h.call("POST", `/api/sessions/${s.id}/validate`, secretariat);
});

afterAll(async () => {
  await h.close();
});

describe("pay rules", () => {
  it("lets only the admin create rules and validates their shape and rhythm", async () => {
    const bySecretariat = await h.call("POST", "/api/payroll/rules", secretariat, {
      instructorId: ids.sana,
      scope: "instructor",
      baseKind: "monthly_flat",
      amount: 1,
      presenceKind: "ignore",
      validFrom: "2026-09-01",
    });
    expect(bySecretariat.status).toBe(403);
    const malformed = await h.call("POST", "/api/payroll/rules", admin, {
      instructorId: ids.sana,
      scope: "group",
      baseKind: "pct_collections",
      presenceKind: "prorata",
      validFrom: "2026-09-01",
    });
    expect(malformed.status).toBe(400);
    const flatPerSession = await h.call("POST", "/api/payroll/rules", admin, {
      instructorId: ids.sana,
      scope: "instructor",
      baseKind: "monthly_flat",
      amount: 1,
      presenceKind: "ignore",
      periodicity: "session",
      validFrom: "2026-09-01",
    });
    expect(flatPerSession.status).toBe(400);
  });

  it("creates the rules of the specification, each with its default rhythm", async () => {
    const sana = await h.call("POST", "/api/payroll/rules", admin, {
      instructorId: ids.sana,
      scope: "instructor",
      baseKind: "pct_collections",
      basisPoints: 6000,
      collectionBasis: "collected",
      presenceKind: "prorata",
      validFrom: "2026-09-01",
    });
    expect(sana.status).toBe(201);
    expect(sana.body.periodicity).toBe("month");
    ids.sanaRule = sana.body.id;
    const ines = await h.call("POST", "/api/payroll/rules", admin, {
      instructorId: ids.ines,
      scope: "instructor",
      baseKind: "monthly_flat",
      amount: 405_000,
      presenceKind: "ignore",
      validFrom: "2026-09-01",
    });
    expect(ines.status).toBe(201);
  });
});

const instructorPay = async (instructorId: string, month: string) =>
  (await h.call("GET", `/api/payroll/instructors/${instructorId}?month=${month}`, accountant)).body;

describe("monthly items, calculated and validated per instructor", () => {
  it("computes 163,200 for 8 students x 40 collected, share 60 %, attendance 85 %", async () => {
    const res = await h.call("POST", "/api/payroll/calculate", accountant, { instructorId: ids.sana, month: "2026-09" });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    const pay = await instructorPay(ids.sana, "2026-09");
    expect(pay.items).toHaveLength(1);
    expect(pay.items[0]).toMatchObject({
      status: "calculated",
      base: 192_000,
      rateNumerator: 34,
      rateDenominator: 40,
      amount: 163_200,
      sessions: 5,
      label: "Groupe A, septembre 2026",
    });
    expect(pay.items[0].details).toMatchObject({ collected: 320_000, sessions: 5, rateBasisPoints: 8500 });
    ids.sanaSeptember = pay.items[0].id;
  });

  it("calculates the same thing twice without duplicating it", async () => {
    const again = await h.call("POST", "/api/payroll/calculate", accountant, { instructorId: ids.sana, month: "2026-09" });
    expect(again.body).toMatchObject({ created: 0, unchanged: 1, replaced: 0 });
  });

  it("pays the monthly flat whatever the attendance, never counts the cancelled session, and leaves other instructors alone", async () => {
    await h.call("POST", "/api/payroll/calculate", accountant, { instructorId: ids.ines, month: "2026-09" });
    const ines = await instructorPay(ids.ines, "2026-09");
    expect(ines.items).toHaveLength(1);
    expect(ines.items[0]).toMatchObject({ amount: 405_000, label: "Forfait mensuel, septembre 2026" });
    expect(ines.items[0].details.sessions).toBe(3);
    ids.inesSeptember = ines.items[0].id;
    // Validating Sana does not require Ines to be validated.
    const validated = await h.call("POST", "/api/payroll/items/validate", accountant, { itemIds: [ids.sanaSeptember] });
    expect(validated.body).toEqual({ validated: 1 });
    expect((await instructorPay(ids.ines, "2026-09")).items[0].status).toBe("calculated");
  });

  it("refuses to validate a month before its last day", async () => {
    await h.call("POST", "/api/payroll/calculate", accountant, { instructorId: ids.ines, month: "2099-12" });
    const future = (await instructorPay(ids.ines, "2099-12")).items[0];
    expect(future).toMatchObject({ dueOn: "2099-12-31", amount: 405_000 });
    const res = await h.call("POST", "/api/payroll/items/validate", accountant, { itemIds: [future.id] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("item_not_due");
  });

  it("never pays a session twice: a later, more specific rule does not reopen validated sessions", async () => {
    const rule = await h.call("POST", "/api/payroll/rules", admin, {
      instructorId: ids.sana,
      scope: "group",
      scopeId: ids.group,
      baseKind: "fixed_per_session",
      amount: 50_000,
      presenceKind: "prorata",
      validFrom: "2026-09-01",
    });
    expect(rule.body.periodicity).toBe("session");
    const res = await h.call("POST", "/api/payroll/calculate", accountant, { instructorId: ids.sana, month: "2026-09" });
    expect(res.body).toMatchObject({ created: 0, replaced: 0 });
    const pay = await instructorPay(ids.sana, "2026-09");
    expect(pay.items.filter((i: { status: string }) => i.status !== "cancelled")).toHaveLength(1);
  });
});

describe("per-session items", () => {
  it("pays a session as soon as its sheet is validated, at that session's attendance", async () => {
    await h.call("POST", `/api/groups/${ids.group}/sessions/generate`, secretariat, { from: "2026-10-01", to: "2026-10-31" });
    const session = (await h.call("GET", "/api/sessions?date=2026-10-06", secretariat)).body.find((s: { groupId: string }) => s.groupId === ids.group);
    await h.call("PUT", `/api/sessions/${session.id}/attendance`, secretariat, {
      records: students.slice(0, 2).map((studentId) => ({ studentId, status: "absent" })),
    });
    await h.call("POST", `/api/sessions/${session.id}/validate`, secretariat);
    await h.call("POST", "/api/payroll/calculate", accountant, { instructorId: ids.sana, month: "2026-10" });
    const pay = await instructorPay(ids.sana, "2026-10");
    const item = pay.items.find((i: { periodKey: string }) => i.periodKey === `session:${session.id}`);
    // 6 of 8 present: 75 % of 50,000.
    expect(item).toMatchObject({ amount: 37_500, dueOn: "2026-10-06", label: "Groupe A, séance du 06/10/2026", sessions: 1 });
    expect((await h.call("POST", "/api/payroll/items/validate", accountant, { itemIds: [item.id] })).status).toBe(200);
    ids.sanaSession = item.id;
  });
});

describe("settlements", () => {
  it("settles items in part, shows what is left and refuses to overpay", async () => {
    const part = await h.call("POST", "/api/payroll/settlements", accountant, {
      instructorId: ids.sana,
      paidOn: "2026-10-10",
      method: "transfer",
      lines: [{ itemId: ids.sanaSeptember, amount: 100_000 }],
    });
    expect(part.status).toBe(201);
    expect(part.body.number).toBe("REG-2026-000001");
    ids.firstSettlement = part.body.id;
    const item = (await instructorPay(ids.sana, "2026-09")).items.find((i: { id: string }) => i.id === ids.sanaSeptember);
    expect(item).toMatchObject({ paid: 100_000, remaining: 63_200 });
    const over = await h.call("POST", "/api/payroll/settlements", accountant, {
      instructorId: ids.sana,
      paidOn: "2026-10-10",
      method: "cash",
      lines: [{ itemId: ids.sanaSeptember, amount: 63_201 }],
    });
    expect(over.status).toBe(422);
    const rest = await h.call("POST", "/api/payroll/settlements", accountant, {
      instructorId: ids.sana,
      paidOn: "2026-10-12",
      method: "cash",
      lines: [
        { itemId: ids.sanaSeptember, amount: 63_200 },
        { itemId: ids.sanaSession, amount: 37_500 },
      ],
    });
    expect(rest.status).toBe(201);
    expect(rest.body.amount).toBe(100_700);
    const twice = await h.call("POST", "/api/payroll/settlements", accountant, {
      instructorId: ids.sana,
      paidOn: "2026-10-12",
      method: "cash",
      lines: [{ itemId: ids.sanaSession, amount: 1 }],
    });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe("already_paid");
    const pdf = await h.app.inject({ method: "GET", url: `/api/payroll/settlements/${rest.body.id}/pdf`, headers: { cookie: accountant } });
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("refuses to settle an item that is not validated or belongs to someone else", async () => {
    const notValidated = await h.call("POST", "/api/payroll/settlements", accountant, {
      instructorId: ids.ines,
      paidOn: "2026-10-10",
      method: "cash",
      lines: [{ itemId: ids.inesSeptember, amount: 1_000 }],
    });
    expect(notValidated.body.code).toBe("item_not_validated");
    const other = await h.call("POST", "/api/payroll/settlements", accountant, {
      instructorId: ids.ines,
      paidOn: "2026-10-10",
      method: "cash",
      lines: [{ itemId: ids.sanaSession, amount: 1_000 }],
    });
    expect(other.body.code).toBe("other_instructor");
  });

  it("deducts a validated deduction in full from the payment", async () => {
    const deduction = await h.call("POST", "/api/payroll/adjustments", accountant, {
      instructorId: ids.ines,
      month: "2026-09",
      kind: "deduction",
      amount: 10_000,
      reason: "Avance sur salaire",
    });
    expect(deduction.status).toBe(201);
    await h.call("POST", "/api/payroll/items/validate", accountant, { itemIds: [ids.inesSeptember, deduction.body.id] });
    const partialDeduction = await h.call("POST", "/api/payroll/settlements", accountant, {
      instructorId: ids.ines,
      paidOn: "2026-10-05",
      method: "cash",
      lines: [
        { itemId: ids.inesSeptember, amount: 405_000 },
        { itemId: deduction.body.id, amount: -5_000 },
      ],
    });
    expect(partialDeduction.body.code).toBe("deduction_in_full");
    const res = await h.call("POST", "/api/payroll/settlements", accountant, {
      instructorId: ids.ines,
      paidOn: "2026-10-05",
      method: "cash",
      lines: [
        { itemId: ids.inesSeptember, amount: 405_000 },
        { itemId: deduction.body.id, amount: -10_000 },
      ],
    });
    expect(res.body.amount).toBe(395_000);
  });
});

describe("corrections and history", () => {
  it("corrects a paid item only after its settlement is cancelled, then recalculates it", async () => {
    const paid = await h.call("POST", `/api/payroll/items/${ids.sanaSeptember}/cancel`, accountant, { reason: "Erreur d'encaissement" });
    expect(paid.body.code).toBe("item_settled");
    const settlements = (await instructorPay(ids.sana, "2026-10")).settlements;
    for (const s of settlements) await h.call("POST", `/api/payroll/settlements/${s.id}/cancel`, accountant, { reason: "Saisi par erreur" });
    expect((await h.call("POST", `/api/payroll/items/${ids.sanaSeptember}/cancel`, accountant, { reason: "Erreur d'encaissement" })).status).toBe(200);
    // The sessions are payable again; the group rule now applies to them, one item per session.
    const res = await h.call("POST", "/api/payroll/calculate", accountant, { instructorId: ids.sana, month: "2026-09" });
    expect(res.body.created).toBe(5);
    const detail = await h.call("GET", `/api/payroll/items/${ids.sanaSeptember}`, accountant);
    expect(detail.body).toMatchObject({ status: "cancelled", cancelReason: "Erreur d'encaissement" });
    expect(detail.body.settlements.map((s: { status: string }) => s.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("keeps the copied rule even when the rule is archived later", async () => {
    await h.call("POST", `/api/payroll/rules/${ids.sanaRule}/archive`, admin, { reason: "Nouvel accord" });
    const detail = await h.call("GET", `/api/payroll/items/${ids.sanaSeptember}`, accountant);
    expect(detail.body.rule.base_kind).toBe("pct_collections");
  });

  it("summarises the month per instructor without any global validation", async () => {
    const res = await h.call("GET", "/api/payroll/summary?month=2026-09", accountant);
    const ines = res.body.instructors.find((i: { id: string }) => i.id === ids.ines);
    expect(ines).toMatchObject({ validated: 395_000, paid: 395_000, remaining: 0, calculated: 0 });
    const sana = res.body.instructors.find((i: { id: string }) => i.id === ids.sana);
    expect(sana.toValidate).toBe(5);
    const events = await h.db
      .selectFrom("financial_events")
      .select(["event_type", sql<number>`sum(amount)::bigint`.as("total")])
      .where("event_type", "like", "payroll%")
      .groupBy("event_type")
      .execute();
    const total = (type: string) => Number(events.find((e) => e.event_type === type)?.total ?? 0);
    expect(total("payroll_validated") + total("payroll_cancelled")).toBe(395_000 + 37_500);
    expect(total("payroll_paid") + total("payroll_payment_cancelled")).toBe(395_000);
  });

  it("warns when a session has no applicable rule", async () => {
    const other = (
      await h.call("POST", "/api/instructors", admin, {
        firstName: "Nabil",
        lastName: "Sans Règle",
        kind: "teacher",
        employment: "freelance",
        subjectIds: [],
        availability: [],
      })
    ).body.id;
    const group = (
      await h.call("POST", "/api/groups", secretariat, {
        kind: "study",
        studyId: ids.study,
        name: "Groupe C",
        instructorId: other,
        startDate: "2026-08-01",
        endDate: "2026-08-31",
        slots: [{ weekday: 1, startTime: "08:00", endTime: "09:00" }],
      })
    ).body.id;
    await h.call("POST", `/api/groups/${group}/sessions/generate`, secretariat, { from: "2026-08-01", to: "2026-08-31" });
    const first = (await h.db.selectFrom("class_sessions").select("id").where("group_id", "=", group).orderBy("starts_at").executeTakeFirstOrThrow()).id;
    await h.call("POST", `/api/sessions/${first}/validate`, secretariat);
    const res = await h.call("POST", "/api/payroll/calculate", accountant, { instructorId: other, month: "2026-08" });
    expect(res.body.warnings).toEqual([expect.objectContaining({ instructorId: other, code: "no_rule" })]);
    const summary = await h.call("GET", "/api/payroll/summary?month=2026-08", accountant);
    expect(summary.body.instructors.find((i: { id: string }) => i.id === other)).toMatchObject({ groupsWithoutRule: 1, sessionsToCalculate: 0 });
  });
});
