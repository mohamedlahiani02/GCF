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
  ids.trainer = (
    await h.call("POST", "/api/instructors", admin, {
      firstName: "Karim",
      lastName: "Trabelsi",
      kind: "trainer",
      employment: "freelance",
      subjectIds: [],
      availability: [],
    })
  ).body.id;
  ids.room = (await h.call("POST", "/api/catalogue/rooms", admin, { name: "Salle A", capacity: 20 })).body.id;
  ids.training = (await h.call("POST", "/api/catalogue/trainings", admin, { title: "Couture", durationHours: 60, price: 600_000, capacity: 10 })).body.id;
  const session = await h.call("POST", `/api/catalogue/trainings/${ids.training}/sessions`, admin, {
    name: "Année 2026",
    startDate: "2026-09-01",
    endDate: "2026-12-31",
  });
  ids.group = (
    await h.call("POST", "/api/groups", secretariat, {
      kind: "training",
      trainingSessionId: session.body.id,
      name: "Couture A",
      instructorId: ids.trainer,
      roomId: ids.room,
      startDate: "2026-09-01",
      endDate: "2026-12-31",
      slots: [],
    })
  ).body.id;
  for (const [key, first] of [
    ["mona", "Mona"],
    ["sami", "Sami"],
    ["rim", "Rim"],
  ] as const) {
    ids[key] = (await h.call("POST", "/api/students", secretariat, { firstName: first, lastName: "Test", isMinor: false })).body.id;
  }
});

afterAll(async () => {
  await h.close();
});

describe("training formulas", () => {
  it("creates monthly and per-session formulas with their tariffs, and refuses incomplete ones", async () => {
    const noTariff = await h.call("POST", `/api/catalogue/trainings/${ids.training}/plans`, admin, { name: "Mensuel", isDefault: false, kind: "monthly" });
    expect(noTariff.status).toBe(400);
    const monthly = await h.call("POST", `/api/catalogue/trainings/${ids.training}/plans`, admin, {
      name: "Mensuel",
      isDefault: true,
      kind: "monthly",
      amount: 150_000,
    });
    expect(monthly.status).toBe(201);
    expect(monthly.body).toMatchObject({ kind: "monthly", amount: 150_000, absenceBilled: null });
    ids.monthly = monthly.body.id;
    const perSession = await h.call("POST", `/api/catalogue/trainings/${ids.training}/plans`, admin, {
      name: "À la séance",
      isDefault: false,
      kind: "per_session",
      amount: 25_000,
      absenceBilled: false,
    });
    expect(perSession.status).toBe(201);
    ids.perSession = perSession.body.id;
    const list = await h.call("GET", "/api/catalogue/trainings", admin);
    expect(list.body.find((t: { id: string }) => t.id === ids.training).formulaKinds.sort()).toEqual(["monthly", "per_session"]);
  });

  it("schedules a monthly formula until the end of the group", async () => {
    const preview = await h.call("POST", "/api/enrolments/preview", secretariat, {
      studentId: ids.mona,
      groupId: ids.group,
      effectiveDate: "2026-10-01",
      planId: ids.monthly,
    });
    expect(preview.status).toBe(200);
    expect(preview.body.paymentMode).toBe("monthly");
    expect(preview.body.lines.map((l: { amount: number; dueDate: string }) => [l.amount, l.dueDate])).toEqual([
      [150_000, "2026-10-01"],
      [150_000, "2026-11-01"],
      [150_000, "2026-12-01"],
    ]);
  });

  it("requires a formula of this training and a matching payment mode", async () => {
    const missing = await h.call("POST", "/api/enrolments/preview", secretariat, { studentId: ids.mona, groupId: ids.group, effectiveDate: "2026-10-01" });
    expect(missing.body.code).toBe("plan_required");
    const mismatch = await h.call("POST", "/api/enrolments/preview", secretariat, {
      studentId: ids.mona,
      groupId: ids.group,
      effectiveDate: "2026-10-01",
      planId: ids.monthly,
      paymentMode: "full",
    });
    expect(mismatch.body.code).toBe("payment_mode_not_allowed");
  });

  it("bills a per-session formula at its own tariff, and not an absence when the formula says so", async () => {
    for (const key of ["sami", "rim"]) {
      const enrolment = await h.call("POST", "/api/enrolments", secretariat, {
        studentId: ids[key],
        groupId: ids.group,
        effectiveDate: "2026-09-01",
        planId: ids.perSession,
      });
      expect(enrolment.status).toBe(201);
    }
    // A later tariff change applies to new enrolments only.
    await h.call("PUT", `/api/catalogue/plans/${ids.perSession}`, admin, {
      name: "À la séance",
      isDefault: false,
      kind: "per_session",
      amount: 30_000,
      absenceBilled: true,
    });
    const session = await h.call("POST", `/api/groups/${ids.group}/sessions`, secretariat, { date: "2026-09-08", startTime: "09:00", endTime: "11:00" });
    expect(session.status).toBe(201);
    await h.call("PUT", `/api/sessions/${session.body.id}/attendance`, secretariat, {
      records: [
        { studentId: ids.sami, status: "present" },
        { studentId: ids.rim, status: "absent" },
      ],
    });
    expect((await h.call("POST", `/api/sessions/${session.body.id}/validate`, secretariat)).status).toBe(200);
    const charges = await h.db
      .selectFrom("installments")
      .innerJoin("enrolments", "enrolments.id", "installments.enrolment_id")
      .select(["enrolments.student_id as studentId", "installments.amount"])
      .where("installments.session_id", "=", session.body.id)
      .where("installments.status", "=", "open")
      .execute();
    expect(charges).toEqual([{ studentId: ids.sami, amount: 25_000 }]);
  });
});
