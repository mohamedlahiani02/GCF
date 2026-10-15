import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
let admin: string;
let secretariat: string;
const ids: Record<string, string> = {};

async function sheet(sessionId: string) {
  return (await h.call("GET", `/api/sessions/${sessionId}/sheet`, secretariat)).body;
}

beforeAll(async () => {
  h = await createHarness();
  await h.createUser("admin", "admin@ses.tn");
  await h.createUser("secretariat", "sec@ses.tn");
  admin = await h.login("admin@ses.tn");
  secretariat = await h.login("sec@ses.tn");
  const subject = (await h.call("POST", "/api/catalogue/subjects", admin, { name: "Physique" })).body.id;
  ids.roomA = (await h.call("POST", "/api/catalogue/rooms", admin, { name: "Salle A", capacity: 20 })).body.id;
  ids.roomB = (await h.call("POST", "/api/catalogue/rooms", admin, { name: "Salle B", capacity: 12 })).body.id;
  const teacher = (n: string) => ({ firstName: n, lastName: "Prof", kind: "teacher", employment: "contractor", subjectIds: [], availability: [] });
  ids.t1 = (await h.call("POST", "/api/instructors", admin, teacher("Rami"))).body.id;
  ids.t2 = (await h.call("POST", "/api/instructors", admin, teacher("Hela"))).body.id;
  ids.perSession = (
    await h.call("POST", "/api/catalogue/studies", admin, {
      subjectId: subject,
      name: "Physique 3e",
      billingMode: "per_session",
      price: 12_000,
      absenceBilled: false,
      sessionsPerWeek: 1,
      capacity: 10,
    })
  ).body.id;
  const group = (name: string, instructorId: string, roomId: string, weekday: number) =>
    h.call("POST", "/api/groups", secretariat, {
      kind: "study",
      studyId: ids.perSession,
      name,
      instructorId,
      roomId,
      startDate: "2026-09-01",
      endDate: "2026-12-31",
      slots: [{ weekday, startTime: "16:00", endTime: "18:00" }],
    });
  ids.gA = (await group("Groupe A", ids.t1!, ids.roomA!, 1)).body.id;
  ids.gB = (await group("Groupe B", ids.t2!, ids.roomB!, 2)).body.id;
  for (const [key, name] of [
    ["s1", "Ines"],
    ["s2", "Omar"],
    ["s3", "Sarra"],
  ] as const) {
    ids[key] = (await h.call("POST", "/api/students", secretariat, { firstName: name, lastName: "Test" })).body.id;
  }
  for (const s of ["s1", "s2"]) {
    await h.call("POST", "/api/enrolments", secretariat, { studentId: ids[s], groupId: ids.gA, effectiveDate: "2026-09-01", paymentMode: "per_session" });
  }
  await h.call("POST", "/api/enrolments", secretariat, { studentId: ids.s3, groupId: ids.gB, effectiveDate: "2026-09-01", paymentMode: "per_session" });
});

afterAll(async () => {
  await h.close();
});

describe("sessions", () => {
  it("generates dated sessions from the weekly slots, idempotently", async () => {
    const first = await h.call("POST", `/api/groups/${ids.gA}/sessions/generate`, secretariat, { from: "2026-10-01", to: "2026-10-31" });
    expect(first.status).toBe(200);
    expect(first.body.created).toBe(4);
    const again = await h.call("POST", `/api/groups/${ids.gA}/sessions/generate`, secretariat, { from: "2026-10-01", to: "2026-10-31" });
    expect(again.body).toMatchObject({ created: 0, skippedExisting: 4 });
    const day = await h.call("GET", "/api/sessions?date=2026-10-05", secretariat);
    expect(day.body).toHaveLength(1);
    expect(new Date(day.body[0].startsAt).toISOString()).toBe("2026-10-05T15:00:00.000Z");
    ids.sessionA = day.body[0].id;
    await h.call("POST", `/api/groups/${ids.gB}/sessions/generate`, secretariat, { from: "2026-10-01", to: "2026-10-31" });
    ids.sessionB = (await h.call("GET", "/api/sessions?date=2026-10-06", secretariat)).body[0].id;
  });

  it("refuses an extra session in a room that is already booked", async () => {
    const res = await h.call("POST", `/api/groups/${ids.gB}/sessions`, secretariat, {
      date: "2026-10-12",
      startTime: "17:00",
      endTime: "19:00",
      roomId: ids.roomA,
    });
    expect(res.status).toBe(409);
    expect(res.body.details.conflicts.map((c: { type: string }) => c.type)).toContain("room");
  });

  it("refuses to move a session onto the instructor's other session", async () => {
    const other = await h.call("POST", `/api/groups/${ids.gB}/sessions`, secretariat, {
      date: "2026-10-14",
      startTime: "10:00",
      endTime: "12:00",
      roomId: ids.roomB,
    });
    expect(other.status).toBe(201);
    const moved = await h.call("PATCH", `/api/sessions/${other.body.id}/move`, secretariat, {
      startsAt: "2026-10-19T15:00:00Z",
      endsAt: "2026-10-19T17:00:00Z",
      roomId: ids.roomB,
      instructorId: ids.t1,
    });
    expect(moved.status).toBe(409);
    expect(moved.body.details.conflicts.map((c: { type: string }) => c.type)).toContain("instructor");
  });
});

describe("attendance sheet", () => {
  it("shows everyone present by default", async () => {
    const s = await sheet(ids.sessionA);
    expect(s.rows.map((r: { status: string; saved: boolean }) => [r.status, r.saved])).toEqual([
      ["present", false],
      ["present", false],
    ]);
  });

  it("records a make-up: absent from the origin group, guest on the host sheet", async () => {
    const res = await h.call("PUT", `/api/sessions/${ids.sessionA}/attendance`, secretariat, {
      records: [{ studentId: ids.s2, status: "present_other_group", hostSessionId: ids.sessionB }],
    });
    expect(res.status).toBe(200);
    const host = await sheet(ids.sessionB);
    const guest = host.rows.find((r: { studentId: string }) => r.studentId === ids.s2);
    expect(guest).toMatchObject({ isGuest: true, originGroupName: "Groupe A", status: "present" });
    expect(host.counters.guests).toBe(1);
  });

  it("validates the sheet, bills present students only when absence is not billed, and locks it", async () => {
    await h.call("PUT", `/api/sessions/${ids.sessionA}/attendance`, secretariat, { records: [{ studentId: ids.s1, status: "absent", note: "Malade" }] });
    const validated = await h.call("POST", `/api/sessions/${ids.sessionA}/validate`, secretariat);
    expect(validated.status).toBe(200);
    const charges = await h.db
      .selectFrom("installments")
      .innerJoin("enrolments", "enrolments.id", "installments.enrolment_id")
      .select(["enrolments.student_id as studentId", "installments.amount"])
      .where("installments.session_id", "=", ids.sessionA)
      .execute();
    expect(charges).toEqual([{ studentId: ids.s2, amount: 12_000 }]);
    const locked = await h.call("PUT", `/api/sessions/${ids.sessionA}/attendance`, secretariat, { records: [{ studentId: ids.s1, status: "present" }] });
    expect(locked.status).toBe(409);
  });

  it("lets only the admin correct a validated sheet, with a reason, and re-bills", async () => {
    const bySecretariat = await h.call("POST", `/api/sessions/${ids.sessionA}/attendance/correct`, secretariat, {
      studentId: ids.s1,
      status: "present",
      reason: "Erreur de saisie",
    });
    expect(bySecretariat.status).toBe(403);
    const corrected = await h.call("POST", `/api/sessions/${ids.sessionA}/attendance/correct`, admin, {
      studentId: ids.s1,
      status: "present",
      reason: "Erreur de saisie",
    });
    expect(corrected.status).toBe(200);
    const charges = await h.db.selectFrom("installments").select("amount").where("session_id", "=", ids.sessionA).where("status", "=", "open").execute();
    expect(charges).toHaveLength(2);
    const audit = await h.db.selectFrom("audit_log").select(["reason"]).where("action", "=", "attendance.corrected").executeTakeFirstOrThrow();
    expect(audit.reason).toBe("Erreur de saisie");
  });

  it("refuses to validate a session that has not started", async () => {
    const future = (await h.call("GET", "/api/sessions?date=2026-10-26", secretariat)).body[0].id;
    const res = await h.call("POST", `/api/sessions/${future}/validate`, secretariat);
    expect(res.status).toBe(422);
  });

  it("computes the group rate with make-ups counted as present by default", async () => {
    const res = await h.call("GET", `/api/groups/${ids.gA}/attendance?from=2026-10-01&to=2026-10-31`, secretariat);
    expect(res.status).toBe(200);
    expect(res.body.groupRate).toEqual({ numerator: 2, denominator: 2 });
    expect(res.body.rows).toHaveLength(2);
  });

  it("cancels a session without attendance and frees its room", async () => {
    const day = (await h.call("GET", "/api/sessions?date=2026-10-19", secretariat)).body[0];
    const cancelled = await h.call("POST", `/api/sessions/${day.id}/cancel`, secretariat, { reason: "Jour férié" });
    expect(cancelled.status).toBe(200);
    const extra = await h.call("POST", `/api/groups/${ids.gB}/sessions`, secretariat, {
      date: "2026-10-19",
      startTime: "16:00",
      endTime: "18:00",
      roomId: ids.roomA,
    });
    expect(extra.status).toBe(201);
  });

  it("renders a printable A4 PDF", async () => {
    const res = await h.app.inject({ method: "GET", url: `/api/sessions/${ids.sessionA}/sheet.pdf`, headers: { cookie: secretariat } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
