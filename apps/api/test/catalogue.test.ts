import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
let admin: string;
let secretariat: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  h = await createHarness();
  await h.createUser("admin", "admin@cat.tn");
  await h.createUser("secretariat", "secretariat@cat.tn");
  admin = await h.login("admin@cat.tn");
  secretariat = await h.login("secretariat@cat.tn");

  ids.maths = (await h.call("POST", "/api/catalogue/subjects", admin, { name: "Mathématiques" })).body.id;
  ids.roomA = (await h.call("POST", "/api/catalogue/rooms", admin, { name: "Salle A", capacity: 20 })).body.id;
  ids.roomB = (await h.call("POST", "/api/catalogue/rooms", admin, { name: "Salle B", capacity: 12 })).body.id;
  ids.sana = (
    await h.call("POST", "/api/instructors", admin, {
      firstName: "Sana",
      lastName: "Ben Salah",
      kind: "teacher",
      employment: "contractor",
      subjectIds: [ids.maths],
      availability: [{ weekday: 3, startTime: "14:00", endTime: "18:00" }],
    })
  ).body.id;
  ids.karim = (
    await h.call("POST", "/api/instructors", admin, {
      firstName: "Karim",
      lastName: "Trabelsi",
      kind: "trainer",
      employment: "freelance",
      subjectIds: [],
      availability: [],
    })
  ).body.id;
  ids.student = (await h.call("POST", "/api/students", secretariat, { firstName: "Rim", lastName: "Jlassi" })).body.id;
  ids.student2 = (await h.call("POST", "/api/students", secretariat, { firstName: "Mohamed", lastName: "Ayari" })).body.id;
});

afterAll(async () => {
  await h.close();
});

describe("private studies and groups", () => {
  it("creates a monthly study with its group and weekly slots", async () => {
    const study = await h.call("POST", "/api/catalogue/studies", admin, {
      subjectId: ids.maths,
      name: "Maths Bac",
      billingMode: "monthly",
      price: 40_000,
      absenceBilled: true,
      sessionsPerWeek: 2,
      capacity: 12,
    });
    expect(study.status).toBe(201);
    ids.study = study.body.id;
    const group = await h.call("POST", "/api/groups", secretariat, {
      kind: "study",
      studyId: ids.study,
      name: "Groupe A",
      instructorId: ids.sana,
      roomId: ids.roomA,
      startDate: "2026-09-01",
      endDate: "2026-12-31",
      capacity: 2,
      slots: [
        { weekday: 3, startTime: "14:00", endTime: "16:00" },
        { weekday: 6, startTime: "09:00", endTime: "11:00" },
      ],
    });
    expect(group.status).toBe(201);
    expect(group.body.effective.price).toBe(40_000);
    expect(group.body.effective.countMakeupAsPresent).toBe(true);
    ids.groupA = group.body.id;
  });

  it("refuses a group whose slot takes the same room at the same time", async () => {
    const res = await h.call("POST", "/api/groups", secretariat, {
      kind: "study",
      studyId: ids.study,
      name: "Groupe B",
      instructorId: ids.karim,
      roomId: ids.roomA,
      startDate: "2026-10-01",
      endDate: "2026-12-31",
      slots: [{ weekday: 3, startTime: "15:00", endTime: "17:00" }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("schedule_conflict");
    expect(res.body.details.conflicts[0]).toMatchObject({ type: "room", groupName: "Groupe A" });
  });

  it("detects an instructor already teaching elsewhere, before saving", async () => {
    const res = await h.call("POST", "/api/groups/check-slots", secretariat, {
      instructorId: ids.sana,
      roomId: ids.roomB,
      startDate: "2026-11-01",
      endDate: "2026-11-30",
      slots: [{ weekday: 6, startTime: "10:00", endTime: "12:00" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.conflicts.map((c: { type: string }) => c.type)).toEqual(["instructor"]);
  });

  it("generates one monthly instalment per month until the end of the group", async () => {
    const preview = await h.call("POST", "/api/enrolments/preview", secretariat, {
      studentId: ids.student,
      groupId: ids.groupA,
      effectiveDate: "2026-10-01",
      paymentMode: "monthly",
      firstDueDate: "2026-10-05",
    });
    expect(preview.status).toBe(200);
    expect(preview.body.lines.map((l: { dueDate: string }) => l.dueDate)).toEqual(["2026-10-05", "2026-11-05", "2026-12-05"]);
    expect(preview.body.total).toBe(120_000);

    const created = await h.call("POST", "/api/enrolments", secretariat, {
      studentId: ids.student,
      groupId: ids.groupA,
      effectiveDate: "2026-10-01",
      paymentMode: "monthly",
      firstDueDate: "2026-10-05",
    });
    expect(created.status).toBe(201);
    const events = await h.db.selectFrom("financial_events").select(["event_type", "amount"]).where("enrolment_id", "=", created.body.id).execute();
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.event_type === "installment_issued" && e.amount === 40_000)).toBe(true);
  });

  it("rejects a payment mode the study does not allow and a duplicate enrolment", async () => {
    const wrongMode = await h.call("POST", "/api/enrolments", secretariat, {
      studentId: ids.student2,
      groupId: ids.groupA,
      effectiveDate: "2026-10-01",
      paymentMode: "full",
    });
    expect(wrongMode.status).toBe(422);
    const duplicate = await h.call("POST", "/api/enrolments", secretariat, {
      studentId: ids.student,
      groupId: ids.groupA,
      effectiveDate: "2026-10-01",
      paymentMode: "monthly",
    });
    expect(duplicate.status).toBe(409);
  });

  it("stops enrolments when the group is full", async () => {
    const second = await h.call("POST", "/api/enrolments", secretariat, {
      studentId: ids.student2,
      groupId: ids.groupA,
      effectiveDate: "2026-10-01",
      paymentMode: "monthly",
    });
    expect(second.status).toBe(201);
    const third = (await h.call("POST", "/api/students", secretariat, { firstName: "Nour", lastName: "Hamdi" })).body.id;
    const full = await h.call("POST", "/api/enrolments", secretariat, {
      studentId: third,
      groupId: ids.groupA,
      effectiveDate: "2026-10-01",
      paymentMode: "monthly",
    });
    expect(full.status).toBe(409);
    expect(full.body.code).toBe("group_full");
  });
});

describe("trainings and payment plans", () => {
  it("rejects a plan that does not add up to the price, and previews it live", async () => {
    const training = await h.call("POST", "/api/catalogue/trainings", admin, {
      title: "Excel avancé",
      durationHours: 40,
      price: 450_000,
      capacity: 12,
      paymentModes: "both",
    });
    expect(training.status).toBe(201);
    ids.training = training.body.id;
    const bad = [4000, 3000, 2000].map((value, i) => ({ label: `Tranche ${i + 1}`, valueKind: "percent", value, dueKind: "relative", dueOffsetDays: i * 21 }));
    const preview = await h.call("POST", `/api/catalogue/trainings/${ids.training}/plans/preview`, admin, { items: bad });
    expect(preview.body.valid).toBe(false);
    const rejected = await h.call("POST", `/api/catalogue/trainings/${ids.training}/plans`, admin, { name: "Mauvais", isDefault: false, items: bad });
    expect(rejected.status).toBe(422);
    expect(rejected.body.code).toBe("plan_total_mismatch");
  });

  it("creates a 40 / 30 / 30 plan and schedules it from the enrolment date", async () => {
    const items = [
      { label: "Tranche 1", valueKind: "percent", value: 4000, dueKind: "relative", dueOffsetDays: 0 },
      { label: "Tranche 2", valueKind: "percent", value: 3000, dueKind: "relative", dueOffsetDays: 21 },
      { label: "Tranche 3", valueKind: "percent", value: 3000, dueKind: "fixed", dueDate: "2026-12-15" },
    ];
    const plan = await h.call("POST", `/api/catalogue/trainings/${ids.training}/plans`, admin, { name: "40 / 30 / 30", isDefault: true, items });
    expect(plan.status).toBe(201);
    const session = await h.call("POST", `/api/catalogue/trainings/${ids.training}/sessions`, admin, {
      name: "Session 3",
      startDate: "2026-11-03",
      endDate: "2026-12-15",
    });
    const group = await h.call("POST", "/api/groups", secretariat, {
      kind: "training",
      trainingSessionId: session.body.id,
      name: "Groupe A",
      instructorId: ids.karim,
      roomId: ids.roomB,
      startDate: "2026-11-03",
      endDate: "2026-12-15",
      slots: [{ weekday: 2, startTime: "09:00", endTime: "11:00" }],
    });
    expect(group.status).toBe(201);
    ids.trainingGroup = group.body.id;

    const preview = await h.call("POST", "/api/enrolments/preview", secretariat, {
      studentId: ids.student2,
      groupId: ids.trainingGroup,
      effectiveDate: "2026-11-03",
      paymentMode: "installments",
      planId: plan.body.id,
      discount: { kind: "amount", value: 45_000, reason: "Fidélité" },
    });
    expect(preview.status).toBe(200);
    expect(preview.body.lines.map((l: { amount: number; dueDate: string }) => [l.amount, l.dueDate])).toEqual([
      [180_000, "2026-11-03"],
      [135_000, "2026-11-24"],
      [135_000, "2026-12-15"],
    ]);
    expect(preview.body.total).toBe(405_000);
    ids.plan = plan.body.id;
  });

  it("keeps a discount entered by the secretariat pending until an admin approves it", async () => {
    const enrolment = await h.call("POST", "/api/enrolments", secretariat, {
      studentId: ids.student2,
      groupId: ids.trainingGroup,
      effectiveDate: "2026-11-03",
      paymentMode: "installments",
      planId: ids.plan,
      discount: { kind: "percent", value: 1000, reason: "Fratrie" },
    });
    expect(enrolment.status).toBe(201);
    const discountRow = await h.db
      .selectFrom("installments")
      .select(["id", "amount", "discount_status"])
      .where("enrolment_id", "=", enrolment.body.id)
      .where("kind", "=", "discount")
      .executeTakeFirstOrThrow();
    expect(discountRow).toMatchObject({ amount: -45_000, discount_status: "pending" });

    const bySecretariat = await h.call("POST", `/api/enrolments/discounts/${discountRow.id}/decision`, secretariat, { approve: true });
    expect(bySecretariat.status).toBe(403);
    const approved = await h.call("POST", `/api/enrolments/discounts/${discountRow.id}/decision`, admin, { approve: true });
    expect(approved.status).toBe(200);
    const event = await h.db
      .selectFrom("financial_events")
      .select(["event_type", "amount"])
      .where("installment_id", "=", discountRow.id)
      .executeTakeFirstOrThrow();
    expect(event).toEqual({ event_type: "discount_granted", amount: -45_000 });
  });

  it("re-splits a percentage plan exactly when the price changes", async () => {
    const res = await h.call("PATCH", `/api/catalogue/trainings/${ids.training}`, admin, { price: 451_000 });
    expect(res.status).toBe(200);
    const plan = await h.call("GET", `/api/catalogue/trainings/${ids.training}`, admin);
    expect(plan.body.plans[0].amounts.reduce((s: number, a: number) => s + a, 0)).toBe(451_000);
  });
});

describe("integrity", () => {
  it("keeps the financial journal append-only", async () => {
    await expect(sql`update financial_events set amount = 0`.execute(h.db)).rejects.toThrow(/append-only/);
  });

  it("refuses a price change that an amount-based plan no longer matches", async () => {
    const training = await h.call("POST", "/api/catalogue/trainings", admin, {
      title: "Comptabilité de base",
      durationHours: 60,
      price: 600_000,
      capacity: 12,
      paymentModes: "installments",
    });
    const items = [
      { label: "Inscription", valueKind: "amount", value: 200_000, dueKind: "relative", dueOffsetDays: 0 },
      { label: "Solde", valueKind: "amount", value: 400_000, dueKind: "relative", dueOffsetDays: 30 },
    ];
    expect((await h.call("POST", `/api/catalogue/trainings/${training.body.id}/plans`, admin, { name: "2 tranches", isDefault: true, items })).status).toBe(
      201,
    );
    const res = await h.call("PATCH", `/api/catalogue/trainings/${training.body.id}`, admin, { price: 650_000 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("plan_total_mismatch");
  });

  it("lets only the admin change the catalogue", async () => {
    const res = await h.call("POST", "/api/catalogue/studies", secretariat, {
      subjectId: ids.maths,
      name: "X",
      billingMode: "monthly",
      price: 1,
      absenceBilled: true,
      sessionsPerWeek: 1,
      capacity: 1,
    });
    expect(res.status).toBe(403);
  });
});
