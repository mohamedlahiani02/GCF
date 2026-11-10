import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
let admin: string;
let sec: string;
let editor: string;
const ids: Record<string, string> = {};
const monthly = (name: string, monthlyDueKind: string) => ({ name, kind: "monthly", amount: 40_000, isDefault: false, monthlyDueKind });
const enrollment = (planId: string) => ({ studentId: ids.student, groupId: ids.group, effectiveDate: "2026-09-15", planId });
beforeAll(async () => {
  h = await createHarness();
  await h.createUser("admin", "admin@x.tn");
  await h.createUser("secretariat", "sec@x.tn");
  await h.createUser("editor", "ed@x.tn");
  admin = await h.login("admin@x.tn");
  sec = await h.login("sec@x.tn");
  editor = await h.login("ed@x.tn");
  const subject = (await h.call("POST", "/api/catalogue/subjects", admin, { name: "Maths" })).body.id;
  ids.study = (
    await h.call("POST", "/api/catalogue/studies", admin, {
      subjectId: subject,
      name: "Mathématiques – Bac",
      billingMode: "monthly",
      price: 40_000,
      absenceBilled: false,
      sessionsPerWeek: 1,
      capacity: 30,
    })
  ).body.id;
  const teacher = (
    await h.call("POST", "/api/instructors", admin, {
      firstName: "Sana",
      lastName: "Test",
      kind: "teacher",
      employment: "contractor",
      subjectIds: [],
      availability: [],
    })
  ).body.id;
  ids.group = (
    await h.call("POST", "/api/groups", sec, {
      kind: "study",
      studyId: ids.study,
      name: "Bac",
      instructorId: teacher,
      startDate: "2026-09-01",
      endDate: "2026-12-15",
      slots: [],
    })
  ).body.id;
  ids.student = (await h.call("POST", "/api/students", sec, { firstName: "Client", lastName: "Test", isMinor: false })).body.id;
});
afterAll(async () => {
  await h.close();
});

describe("billing choices and projections", () => {
  it("offers both beginning and end of month, with permissions and strict timing validation", async () => {
    expect((await h.call("POST", `/api/catalogue/studies/${ids.study}/plans`, sec, monthly("Fin", "month_end"))).status).toBe(403);
    for (const [key, timing] of [
      ["start", "month_start"],
      ["end", "month_end"],
    ]) {
      const result = await h.call("POST", `/api/catalogue/studies/${ids.study}/plans`, admin, monthly(key!, timing!));
      expect(result.status).toBe(201);
      ids[key!] = result.body.id;
    }
    const bad = await h.call("POST", `/api/catalogue/studies/${ids.study}/plans`, admin, monthly("Jour manquant", "day_of_month"));
    expect(bad.status).toBe(400);
    const detail = await h.call("GET", `/api/catalogue/studies/${ids.study}`, sec);
    expect(detail.body.plans.map((p: { monthlyDueKind: string }) => p.monthlyDueKind).sort()).toEqual(["month_end", "month_start"]);
  });
  it("previews the chosen dates and refuses bypassing an agreed formula", async () => {
    const start = await h.call("POST", "/api/enrolments/preview", sec, enrollment(ids.start!));
    const end = await h.call("POST", "/api/enrolments/preview", sec, enrollment(ids.end!));
    expect(start.body.lines.map((l: { dueDate: string }) => l.dueDate)).toEqual(["2026-09-15", "2026-10-01", "2026-11-01", "2026-12-01"]);
    expect(end.body.lines.map((l: { dueDate: string }) => l.dueDate)).toEqual(["2026-09-30", "2026-10-31", "2026-11-30", "2026-12-31"]);
    expect((await h.call("POST", "/api/enrolments/preview", sec, { ...enrollment(ids.end!), firstDueDate: "2026-09-01" })).body.code).toBe(
      "due_date_from_formula",
    );
    const { planId: _unused, ...withoutPlan } = enrollment(ids.end!);
    expect((await h.call("POST", "/api/enrolments/preview", sec, withoutPlan)).body.code).toBe("plan_required");
    expect((await h.call("POST", "/api/enrolments/preview", sec, { ...enrollment(ids.end!), planId: crypto.randomUUID() })).body.code).toBe("unknown_plan");
  });
  it("keeps future periods out of current debt, while permitting explicit advance payment", async () => {
    const result = await h.call("POST", "/api/enrolments", sec, enrollment(ids.end!));
    expect(result.status).toBe(201);
    ids.enrolment = result.body.id;
    const account = await h.call("GET", `/api/students/${ids.student}/account`, sec);
    expect(account.body.totals).toEqual({ due: 40_000, future: 120_000, totalRemaining: 160_000, asOf: "2026-10-20", credit: 0, pendingDiscounts: 0 });
    const future = account.body.installments.find((l: { dueDate: string }) => l.dueDate === "2026-11-30");
    const preview = await h.call("POST", "/api/payments/preview", sec, { studentId: ids.student, amount: 50_000, installmentIds: [future.id] });
    expect(preview.status).toBe(200);
    expect(preview.body.after).toMatchObject({ due: 30_000, future: 80_000, totalRemaining: 110_000, credit: 0 });
    expect(await h.db.selectFrom("payments").select("id").execute()).toHaveLength(0);
    const list = await h.call("GET", "/api/payments/overdue", sec);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ studentId: ids.student, dueDate: "2026-09-30", remaining: 40_000 });
    expect((await h.call("GET", "/api/payments/overdue", editor)).status).toBe(403);
    const studentList = await h.call("GET", "/api/students", sec);
    expect(studentList.body.items[0].due).toBe(40_000);
  });
  it("preserves snapshots and existing dates when a formula changes", async () => {
    expect((await h.call("PUT", `/api/catalogue/plans/${ids.end}`, admin, monthly("Fin modifiée", "month_start"))).status).toBe(200);
    const stored = await h.db
      .selectFrom("enrolments")
      .select(["monthly_due_kind", "due_offset_days"])
      .where("id", "=", ids.enrolment!)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({ monthly_due_kind: "month_end", due_offset_days: 0 });
    const lines = await h.db.selectFrom("installments").select("due_date").where("enrolment_id", "=", ids.enrolment!).orderBy("due_date").execute();
    expect(lines.map((l) => l.due_date)).toEqual(["2026-09-30", "2026-10-31", "2026-11-30", "2026-12-31"]);
  });
  it("supports explicit whole-course packages and personalized installments", async () => {
    expect((await h.call("POST", `/api/catalogue/studies/${ids.study}/plans`, admin, { name: "Sans prix", kind: "full", isDefault: false })).body.code).toBe(
      "package_price_required",
    );
    const full = await h.call("POST", `/api/catalogue/studies/${ids.study}/plans`, admin, { name: "4 mois", kind: "full", amount: 150_000, isDefault: false });
    expect(full.status).toBe(201);
    const preview = await h.call("POST", "/api/enrolments/preview", sec, enrollment(full.body.id));
    expect(preview.body.lines).toHaveLength(1);
    expect(preview.body.total).toBe(150_000);
    const custom = await h.call("POST", `/api/catalogue/studies/${ids.study}/plans`, admin, {
      name: "Sur mesure",
      kind: "installments",
      amount: 160_000,
      isDefault: false,
      items: [
        { label: "Première tranche", valueKind: "percent", value: 2500, dueKind: "relative", dueOffsetDays: 0 },
        { label: "Solde", valueKind: "percent", value: 7500, dueKind: "fixed", dueDate: "2026-12-15" },
      ],
    });
    expect(custom.status).toBe(201);
    const customPreview = await h.call("POST", "/api/enrolments/preview", sec, enrollment(custom.body.id));
    expect(customPreview.body.lines.map((l: { dueDate: string; amount: number }) => [l.amount, l.dueDate])).toEqual([
      [40_000, "2026-09-15"],
      [120_000, "2026-12-15"],
    ]);
  });
  it("bills sessions with their enrollment tariff and delay, even after the formula is edited", async () => {
    const plan = await h.call("POST", `/api/catalogue/studies/${ids.study}/plans`, admin, {
      name: "Séances",
      kind: "per_session",
      amount: 12_000,
      absenceBilled: false,
      dueOffsetDays: 7,
      isDefault: false,
    });
    const student = (await h.call("POST", "/api/students", sec, { firstName: "Séance", lastName: "Test", isMinor: false })).body.id;
    expect((await h.call("POST", "/api/enrolments", sec, { ...enrollment(plan.body.id), studentId: student })).status).toBe(201);
    await h.call("PUT", `/api/catalogue/plans/${plan.body.id}`, admin, {
      name: "Séances modifiées",
      kind: "per_session",
      amount: 20_000,
      absenceBilled: false,
      dueOffsetDays: 0,
      isDefault: false,
    });
    const session = await h.call("POST", `/api/groups/${ids.group}/sessions`, sec, { date: "2026-10-19", startTime: "09:00", endTime: "10:00" });
    expect(session.status).toBe(201);
    await h.call("PUT", `/api/sessions/${session.body.id}/attendance`, sec, {
      records: [
        { studentId: ids.student, status: "absent" },
        { studentId: student, status: "present" },
      ],
    });
    expect((await h.call("POST", `/api/sessions/${session.body.id}/validate`, sec)).status).toBe(200);
    const charge = await h.db.selectFrom("installments").select(["amount", "due_date"]).where("session_id", "=", session.body.id).execute();
    expect(charge).toEqual([{ amount: 12_000, due_date: "2026-10-26" }]);
  });
});

it("retains the started month at dropout and moves only future service periods at transfer", async () => {
  const plan = await h.call("POST", `/api/catalogue/studies/${ids.study}/plans`, admin, monthly("Fin pour mouvements", "month_end"));
  const create = async (name: string) => {
    const student = (await h.call("POST", "/api/students", sec, { firstName: name, lastName: "Périodes", isMinor: false })).body.id;
    const result = await h.call("POST", "/api/enrolments", sec, { ...enrollment(plan.body.id), studentId: student });
    expect(result.status).toBe(201);
    return result.body.id as string;
  };
  const dropped = await create("Abandon");
  expect((await h.call("POST", `/api/enrolments/${dropped}/drop`, sec, { date: "2026-10-20", reason: "Arrêt du cours" })).status).toBe(200);
  const charges = await h.db
    .selectFrom("installments")
    .select(["due_date", "status", "service_period_start"])
    .where("enrolment_id", "=", dropped)
    .where("kind", "=", "charge")
    .orderBy("due_date")
    .execute();
  expect(charges.map((c) => [c.due_date, c.status])).toEqual([
    ["2026-09-30", "open"],
    ["2026-10-31", "open"],
    ["2026-11-30", "cancelled"],
    ["2026-12-31", "cancelled"],
  ]);
  const group = await h.db.selectFrom("groups").selectAll().where("id", "=", ids.group!).executeTakeFirstOrThrow();
  const target = await h.call("POST", "/api/groups", sec, {
    kind: "study",
    studyId: ids.study,
    name: "Bac B",
    instructorId: group.instructor_id,
    startDate: "2026-09-01",
    endDate: "2026-12-15",
    slots: [],
  });
  expect(target.status).toBe(201);
  const source = await create("Transfert");
  const transfer = await h.call("POST", `/api/enrolments/${source}/transfer`, sec, {
    newGroupId: target.body.id,
    effectiveDate: "2026-10-20",
    mode: "keep",
    reason: "Autre groupe",
  });
  expect(transfer.status).toBe(200);
  expect(transfer.body.movedInstallments).toBe(2);
  const moved = await h.db
    .selectFrom("installments")
    .select(["due_date", "service_period_start", "service_period_end"])
    .where("enrolment_id", "=", transfer.body.newEnrolmentId)
    .orderBy("due_date")
    .execute();
  expect(moved).toEqual([
    { due_date: "2026-11-30", service_period_start: "2026-11-01", service_period_end: "2026-11-30" },
    { due_date: "2026-12-31", service_period_start: "2026-12-01", service_period_end: "2026-12-15" },
  ]);
});

it("never discloses another centre’s payer credit in a preview without selected installments", async () => {
  const foreignCentre = await h.db.insertInto("centres").values({ name: "Autre centre" }).returning("id").executeTakeFirstOrThrow();
  const foreign = await sql<{
    id: string;
  }>`insert into students (centre_id, first_name, last_name) values (${foreignCentre.id}, 'Autre', 'Client') returning id`.execute(h.db);
  await sql`insert into payments (centre_id, student_id, amount, method) values (${foreignCentre.id}, ${foreign.rows[0]!.id}, 50000, 'cash')`.execute(h.db);
  const denied = await h.call("POST", "/api/payments/preview", sec, { studentId: foreign.rows[0]!.id, amount: 1000, installmentIds: [] });
  expect(denied.status).toBe(404);
  expect(denied.body).not.toHaveProperty("before");
});
