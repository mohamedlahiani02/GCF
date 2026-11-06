import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
let admin: string;
let secretariat: string;
let accountant: string;
const ids: Record<string, string> = {};
const students: string[] = [];

interface Item {
  id: string;
  periodKey: string;
  status: string;
  amount: number;
  details: { sessions: number; cancelledSessions?: number; cancelledPay?: number; rateBasisPoints: number | null };
}

const instructorItems = async (instructorId: string, month: string): Promise<Item[]> =>
  (await h.call("GET", `/api/payroll/instructors/${instructorId}?month=${month}`, accountant)).body.items.filter((i: Item) => i.status !== "cancelled");

const sessionOn = async (date: string) =>
  (await h.call("GET", `/api/sessions?date=${date}`, secretariat)).body.find((s: { groupId: string }) => s.groupId === ids.group) as { id: string };

beforeAll(async () => {
  h = await createHarness();
  await h.createUser("admin", "admin@options.tn");
  await h.createUser("secretariat", "sec@options.tn");
  await h.createUser("accountant", "compta@options.tn");
  admin = await h.login("admin@options.tn");
  secretariat = await h.login("sec@options.tn");
  accountant = await h.login("compta@options.tn");
  const subject = (await h.call("POST", "/api/catalogue/subjects", admin, { name: "Physique" })).body.id;
  ids.teacher = (
    await h.call("POST", "/api/instructors", admin, {
      firstName: "Karim",
      lastName: "Jaziri",
      kind: "teacher",
      employment: "contractor",
      subjectIds: [],
      availability: [],
    })
  ).body.id;
  ids.study = (
    await h.call("POST", "/api/catalogue/studies", admin, {
      subjectId: subject,
      name: "Physique Bac",
      billingMode: "monthly",
      price: 50_000,
      absenceBilled: true,
      sessionsPerWeek: 1,
      capacity: 10,
    })
  ).body.id;
  ids.group = (
    await h.call("POST", "/api/groups", secretariat, {
      kind: "study",
      studyId: ids.study,
      name: "Physique A",
      instructorId: ids.teacher,
      startDate: "2026-10-01",
      endDate: "2026-12-31",
      slots: [{ weekday: 1, startTime: "15:00", endTime: "16:30" }],
    })
  ).body.id;
  for (let i = 1; i <= 2; i += 1) {
    const id = (await h.call("POST", "/api/students", secretariat, { firstName: `Élève${i}`, lastName: "Physique" })).body.id;
    students.push(id);
    await h.call("POST", "/api/enrolments", secretariat, {
      studentId: id,
      groupId: ids.group,
      effectiveDate: "2026-10-01",
      paymentMode: "monthly",
      firstDueDate: "2026-10-05",
    });
  }
  // October 2026 Mondays: the 5th is attended, the 12th has nobody present, the 19th is cancelled, the 26th stays scheduled.
  await h.call("POST", `/api/groups/${ids.group}/sessions/generate`, secretariat, { from: "2026-10-01", to: "2026-10-31" });
  const attended = await sessionOn("2026-10-05");
  expect((await h.call("POST", `/api/sessions/${attended.id}/validate`, secretariat)).status).toBe(200);
  const empty = await sessionOn("2026-10-12");
  await h.call("PUT", `/api/sessions/${empty.id}/attendance`, secretariat, {
    records: students.map((studentId) => ({ studentId, status: "absent" })),
  });
  expect((await h.call("POST", `/api/sessions/${empty.id}/validate`, secretariat)).status).toBe(200);
  const cancelled = await sessionOn("2026-10-19");
  expect((await h.call("POST", `/api/sessions/${cancelled.id}/cancel`, secretariat, { reason: "Salle indisponible" })).status).toBe(200);
  ids.attended = attended.id;
  ids.empty = empty.id;
  ids.cancelled = cancelled.id;
});

afterAll(async () => {
  await h.close();
});

const rule = (overrides: Record<string, unknown>) =>
  h.call("POST", "/api/payroll/rules", admin, {
    instructorId: ids.teacher,
    scope: "group",
    scopeId: ids.group,
    baseKind: "fixed_per_session",
    amount: 30_000,
    presenceKind: "ignore",
    validFrom: "2026-10-01",
    ...overrides,
  });

describe("session options of a pay rule", () => {
  it("keeps the former behaviour by default: the unattended session is paid, the cancelled one is not", async () => {
    const created = await rule({});
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ pay_cancelled_sessions: false, pay_empty_sessions: true });
    await h.call("POST", "/api/payroll/calculate", accountant, { instructorId: ids.teacher, month: "2026-10" });
    const items = await instructorItems(ids.teacher, "2026-10");
    expect(items.map((i) => i.periodKey).sort()).toEqual([`session:${ids.attended}`, `session:${ids.empty}`].sort());
    expect(items.every((i) => i.amount === 30_000)).toBe(true);
    await h.call("POST", `/api/payroll/rules/${created.body.id}/archive`, admin, { reason: "Nouvel accord" });
  });

  it("pays the cancelled session at 100 % and leaves out the session with nobody present when the rule says so", async () => {
    const created = await rule({ presenceKind: "prorata", payCancelledSessions: true, payEmptySessions: false });
    expect(created.status).toBe(201);
    const calc = await h.call("POST", "/api/payroll/calculate", accountant, { instructorId: ids.teacher, month: "2026-10" });
    // The items of the archived rule are replaced, not left beside the new ones.
    expect(calc.status).toBe(200);
    const items = await instructorItems(ids.teacher, "2026-10");
    const byKey = new Map(items.map((i) => [i.periodKey, i]));
    expect(byKey.has(`session:${ids.empty}`)).toBe(false);
    expect(byKey.get(`session:${ids.attended}`)).toMatchObject({ amount: 30_000, details: { sessions: 1, rateBasisPoints: 10_000 } });
    expect(byKey.get(`session:${ids.cancelled}`)).toMatchObject({ amount: 30_000, details: { sessions: 0, cancelledSessions: 1, cancelledPay: 30_000 } });
    await h.call("POST", `/api/payroll/rules/${created.body.id}/archive`, admin, { reason: "Nouvel accord" });
  });

  it("adds the cancelled session to the month without letting it change the attendance rate", async () => {
    const created = await rule({ presenceKind: "prorata", periodicity: "month", payCancelledSessions: true });
    expect(created.status).toBe(201);
    await h.call("POST", "/api/payroll/calculate", accountant, { instructorId: ids.teacher, month: "2026-10" });
    const [item, ...others] = await instructorItems(ids.teacher, "2026-10");
    expect(others).toHaveLength(0);
    // Held: 2 sessions x 30,000 at 2 present out of 4 = 50 %, so 30,000; plus the cancelled session at 100 %.
    expect(item).toMatchObject({ periodKey: "month:2026-10", amount: 60_000, details: { sessions: 2, cancelledSessions: 1, rateBasisPoints: 5_000 } });
  });

  it("refuses the session options on a base that is not counted per session, and the former session-due effect", async () => {
    const monthly = await rule({ baseKind: "monthly_flat", amount: 300_000, payCancelledSessions: true });
    expect(monthly.status).toBe(400);
    const sessionDue = await rule({ presenceKind: "session_due" });
    expect(sessionDue.status).toBe(400);
  });
});
