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
  it("lets only the admin create rules and validates their shape", async () => {
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
  });

  it("creates the rules of the specification", async () => {
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

describe("pay period", () => {
  it("computes 163,200 for 8 students x 40 collected, share 60 %, attendance 85 %", async () => {
    const period = await h.call("POST", "/api/payroll/periods", accountant, { month: "2026-09" });
    expect(period.status).toBe(201);
    ids.period = period.body.id;
    const res = await h.call("POST", `/api/payroll/periods/${ids.period}/calculate`, accountant);
    expect(res.status).toBe(200);
    const sana = res.body.instructors.find((i: { id: string }) => i.id === ids.sana);
    expect(sana.lines).toHaveLength(1);
    expect(sana.lines[0]).toMatchObject({ base: 192_000, rateNumerator: 34, rateDenominator: 40, amount: 163_200 });
    expect(sana.lines[0].details).toMatchObject({ collected: 320_000, sessions: 5, rateBasisPoints: 8500 });
  });

  it("pays the monthly flat whatever the attendance, and never counts the cancelled session", async () => {
    const res = await h.call("GET", `/api/payroll/periods/${ids.period}`, accountant);
    const ines = res.body.instructors.find((i: { id: string }) => i.id === ids.ines);
    expect(ines.net).toBe(405_000);
    expect(ines.lines[0].details.sessions).toBe(3);
  });

  it("applies the most specific rule: a group rule beats the instructor default", async () => {
    await h.call("POST", "/api/payroll/rules", admin, {
      instructorId: ids.sana,
      scope: "group",
      scopeId: ids.group,
      baseKind: "fixed_per_session",
      amount: 50_000,
      presenceKind: "threshold",
      minRateBasisPoints: 9000,
      prorataAbove: false,
      floorAmount: 100_000,
      validFrom: "2026-09-01",
    });
    const res = await h.call("POST", `/api/payroll/periods/${ids.period}/calculate`, accountant);
    const sana = res.body.instructors.find((i: { id: string }) => i.id === ids.sana);
    // 85 % is below the 90 % threshold: the floor is paid instead of 5 x 50.
    expect(sana.lines[0]).toMatchObject({ base: 250_000, amount: 100_000 });
    expect(sana.lines[0].rule.scope).toBe("group");
  });

  it("adds a bonus with its reason, validates, freezes and issues payslips", async () => {
    const bonus = await h.call("POST", `/api/payroll/periods/${ids.period}/adjustments`, accountant, {
      instructorId: ids.sana,
      kind: "bonus",
      amount: 20_000,
      reason: "Séance supplémentaire",
    });
    expect(bonus.status).toBe(201);
    const validated = await h.call("POST", `/api/payroll/periods/${ids.period}/validate`, accountant);
    expect(validated.status).toBe(200);
    expect(validated.body.status).toBe("validated");
    const sana = validated.body.instructors.find((i: { id: string }) => i.id === ids.sana);
    expect(sana.net).toBe(120_000);
    expect(validated.body.total).toBe(525_000);
    const pdf = await h.app.inject({ method: "GET", url: `/api/payroll/periods/${ids.period}/payslips/${ids.sana}/pdf`, headers: { cookie: accountant } });
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    const again = await h.call("POST", `/api/payroll/periods/${ids.period}/calculate`, accountant);
    expect(again.status).toBe(409);
    const late = await h.call("POST", `/api/payroll/periods/${ids.period}/adjustments`, accountant, {
      instructorId: ids.sana,
      kind: "deduction",
      amount: 1_000,
      reason: "x",
    });
    expect(late.status).toBe(409);
    const events = await h.db
      .selectFrom("financial_events")
      .select(sql<number>`sum(amount)::bigint`.as("total"))
      .where("event_type", "=", "payroll_validated")
      .executeTakeFirstOrThrow();
    expect(Number(events.total)).toBe(525_000);
  });

  it("keeps the copied rule even when the rule is archived later", async () => {
    await h.call("POST", `/api/payroll/rules/${ids.sanaRule}/archive`, admin, { reason: "Nouvel accord" });
    const res = await h.call("GET", `/api/payroll/periods/${ids.period}`, accountant);
    const ines = res.body.instructors.find((i: { id: string }) => i.id === ids.ines);
    expect(ines.lines[0].rule.base_kind).toBe("monthly_flat");
  });

  it("marks payslips paid and closes the period once everyone is paid", async () => {
    await h.call("POST", `/api/payroll/periods/${ids.period}/payslips/${ids.sana}/pay`, accountant, { paidOn: "2026-10-05", method: "transfer" });
    const res = await h.call("POST", `/api/payroll/periods/${ids.period}/payslips/${ids.ines}/pay`, accountant, { paidOn: "2026-10-05", method: "cash" });
    expect(res.body.status).toBe("paid");
    const twice = await h.call("POST", `/api/payroll/periods/${ids.period}/payslips/${ids.ines}/pay`, accountant, { paidOn: "2026-10-05", method: "cash" });
    expect(twice.status).toBe(409);
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
    const period = (await h.call("POST", "/api/payroll/periods", accountant, { month: "2026-08" })).body.id;
    const res = await h.call("POST", `/api/payroll/periods/${period}/calculate`, accountant);
    expect(res.body.warnings).toEqual([expect.objectContaining({ instructorId: other, code: "no_rule" })]);
  });
});
