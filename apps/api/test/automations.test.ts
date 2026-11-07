import type { FastifyBaseLogger } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runDueAutomations } from "../src/domain/automations/scheduler.js";
import { createHarness, RecordingMailer, type Harness } from "./harness.js";

let h: Harness;
let admin: string;
let secretariat: string;
let accountant: string;
const mailer = new RecordingMailer();
const ids: Record<string, string> = {};

const silent = { error: () => undefined, warn: () => undefined, info: () => undefined } as unknown as FastifyBaseLogger;
const run = (iso: string) => runDueAutomations(h.db, mailer, silent, new Date(iso));
const setting = (key: string, mode: string, params: Record<string, unknown> = {}) => h.call("PUT", `/api/automations/settings/${key}`, admin, { mode, params });
const runsOf = (key: string) =>
  h.db
    .selectFrom("automation_runs")
    .selectAll()
    .where("key", "=", key as "daily_digest")
    .orderBy("started_at")
    .orderBy("period_key")
    .execute();
/** Lets a test run a period again: its earlier runs (and the proposals they made) are removed. */
const forgetRuns = async (key: string) => {
  const runs = await h.db
    .selectFrom("automation_runs")
    .select("id")
    .where("key", "=", key as "daily_digest")
    .execute();
  if (!runs.length) return;
  await h.db
    .deleteFrom("proposals")
    .where(
      "run_id",
      "in",
      runs.map((r) => r.id),
    )
    .execute();
  await h.db
    .deleteFrom("automation_runs")
    .where("key", "=", key as "daily_digest")
    .execute();
};
const pending = async (cookie: string) =>
  (await h.call("GET", "/api/automations/proposals", cookie)).body as { id: string; kind: string; title: string; summary: any }[];

beforeAll(async () => {
  h = await createHarness({ mailer });
  await h.setModules(["training", "coworking"]);
  await h.createUser("admin", "admin@auto.tn");
  await h.createUser("secretariat", "sec@auto.tn");
  await h.createUser("accountant", "compta@auto.tn");
  admin = await h.login("admin@auto.tn");
  secretariat = await h.login("sec@auto.tn");
  accountant = await h.login("compta@auto.tn");

  const subject = (await h.call("POST", "/api/catalogue/subjects", admin, { name: "Physique" })).body.id;
  const instructor = async (firstName: string) =>
    (
      await h.call("POST", "/api/instructors", admin, {
        firstName,
        lastName: "Prof",
        kind: "teacher",
        employment: "contractor",
        subjectIds: [],
        availability: [],
      })
    ).body.id as string;
  ids.karim = await instructor("Karim");
  ids.lina = await instructor("Lina");
  const study = (
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
  const group = async (name: string, instructorId: string, weekday: number) =>
    (
      await h.call("POST", "/api/groups", secretariat, {
        kind: "study",
        studyId: study,
        name,
        instructorId,
        startDate: "2026-09-01",
        endDate: "2026-12-31",
        slots: [{ weekday, startTime: "15:00", endTime: "16:30" }],
      })
    ).body.id as string;
  ids.groupA = await group("Physique A", ids.karim, 1);
  ids.groupB = await group("Physique B", ids.lina, 3);

  const student = async (firstName: string, extra: Record<string, unknown>) =>
    (await h.call("POST", "/api/students", secretariat, { firstName, lastName: "Élève", ...extra })).body.id as string;
  ids.rim = await student("Rim", { email: "rim@example.tn" });
  ids.sami = await student("Sami", { email: "sami@example.tn" });
  ids.noMail = await student("Nomail", {});
  for (const studentId of [ids.rim, ids.sami, ids.noMail]) {
    await h.call("POST", "/api/enrolments", secretariat, {
      studentId,
      groupId: ids.groupA,
      effectiveDate: "2026-09-01",
      paymentMode: "monthly",
      firstDueDate: "2026-09-05",
    });
  }
  // October: Karim's Monday group has a rule and one validated session; Lina's Wednesday group has none.
  for (const g of [ids.groupA, ids.groupB]) await h.call("POST", `/api/groups/${g}/sessions/generate`, secretariat, { from: "2026-10-01", to: "2026-10-31" });
  const sessionOn = async (date: string, groupId: string) =>
    ((await h.call("GET", `/api/sessions?date=${date}`, secretariat)).body as { id: string; groupId: string }[]).find((s) => s.groupId === groupId)!.id;
  expect((await h.call("POST", `/api/sessions/${await sessionOn("2026-10-05", ids.groupA)}/validate`, secretariat)).status).toBe(200);
  expect((await h.call("POST", `/api/sessions/${await sessionOn("2026-10-07", ids.groupB)}/validate`, secretariat)).status).toBe(200);
  const rule = await h.call("POST", "/api/payroll/rules", admin, {
    instructorId: ids.karim,
    scope: "group",
    scopeId: ids.groupA,
    baseKind: "fixed_per_session",
    amount: 30_000,
    presenceKind: "ignore",
    validFrom: "2026-09-01",
  });
  expect(rule.status).toBe(201);
});

afterAll(async () => {
  await h.close();
});

beforeEach(() => {
  mailer.sent.length = 0;
});

describe("automation settings", () => {
  it("are off by default, administrator only, and checked against each automation", async () => {
    const list = await h.call("GET", "/api/automations/settings", admin);
    expect(list.status).toBe(200);
    expect(list.body.map((s: { key: string; mode: string }) => [s.key, s.mode])).toEqual([
      ["overdue_reminders", "off"],
      ["payroll_month", "off"],
      ["daily_digest", "off"],
      ["mail_item_notice", "off"],
    ]);
    expect(list.body[0].params).toEqual({ weekday: 1, hour: 9, minDaysBetween: 7, minAmount: 0 });
    expect((await h.call("GET", "/api/automations/settings", secretariat)).status).toBe(403);
    expect((await h.call("PUT", "/api/automations/settings/daily_digest", secretariat, { mode: "auto" })).status).toBe(403);
    expect((await setting("daily_digest", "propose")).body.code).toBe("mode_not_allowed");
    expect((await setting("overdue_reminders", "auto", { weekday: 8 })).status).toBe(400);
    expect((await setting("overdue_reminders", "auto", { unknown: 1 })).status).toBe(400);
    expect((await setting("unknown_key", "auto")).status).toBe(400);
  });

  it("never fire in the period in which they are switched on", async () => {
    // Tuesday 20 October 2026, 09:00 in Tunis: the digest hour (08:00) has already passed today.
    const saved = await setting("daily_digest", "auto", { hour: 8, roles: ["secretariat"] });
    expect(saved.body).toMatchObject({ mode: "auto", params: { hour: 8, roles: ["secretariat"] } });
    expect(await run("2026-10-20T09:00:00Z")).toBe(0);
    expect((await runsOf("daily_digest")).map((r) => [r.period_key, r.status])).toEqual([["2026-10-20", "skipped"]]);
    expect(mailer.sent).toHaveLength(0);
    await setting("daily_digest", "off");
  });
});

describe("daily digest", () => {
  it("e-mails tomorrow's sessions to the chosen roles once a day", async () => {
    await forgetRuns("daily_digest");
    await setting("daily_digest", "auto", { hour: 18, roles: ["secretariat", "accountant"] });
    expect(await run("2026-10-20T16:30:00Z")).toBe(0);
    // 18:30 in Tunis: due. Tomorrow is Wednesday 21 October, when group B meets.
    expect(await run("2026-10-20T17:30:00Z")).toBe(1);
    expect(mailer.sent.map((m) => m.to).sort()).toEqual(["compta@auto.tn", "sec@auto.tn"]);
    const text = mailer.sent[0]!.text;
    expect(mailer.sent[0]!.subject).toBe("Centre de test : programme du 21/10/2026");
    expect(text).toContain("Séances (1) :");
    expect(text).toContain("- 15:00-16:30 Physique B, Lina Prof");
    expect(text).toContain("Réservations du coworking (0) :");
    // A second server, or a second tick, does not send it again.
    expect(await run("2026-10-20T17:31:00Z")).toBe(0);
    expect(mailer.sent).toHaveLength(2);
    const [done] = await runsOf("daily_digest");
    expect(done).toMatchObject({ status: "done", summary: { date: "2026-10-21", sessions: 1, recipients: 2, sent: 2 } });
    await setting("daily_digest", "off");
  });
});

describe("weekly overdue reminders", () => {
  it("prepare a proposal that a secretary confirms, then e-mail only who still owes", async () => {
    await setting("overdue_reminders", "propose", { weekday: 1, hour: 9 });
    // Monday 26 October, 09:30 in Tunis.
    expect(await run("2026-10-26T08:30:00Z")).toBe(1);
    expect(mailer.sent).toHaveLength(0);
    const [proposal, ...others] = await pending(secretariat);
    expect(others).toHaveLength(0);
    expect(proposal).toMatchObject({ kind: "reminders.send", title: "Relances de la semaine : 2 élèves, 200,000 TND" });
    expect(proposal!.summary.students.map((s: { name: string }) => s.name)).toEqual(["Rim Élève", "Sami Élève"]);
    expect(proposal!.summary.skipped).toEqual({ noRecipient: 1, remindedRecently: 0, belowMinimum: 0 });
    // An accountant cannot send reminders, so the proposal is not theirs to see or decide.
    expect(await pending(accountant)).toHaveLength(0);
    expect((await h.call("POST", `/api/automations/proposals/${proposal!.id}/decision`, accountant, { approve: true })).status).toBe(403);
    expect((await h.call("GET", "/api/automations/proposals/count", secretariat)).body).toEqual({ pending: 1 });

    // Sami pays everything before the proposal is confirmed.
    const paid = await h.call("POST", "/api/payments", secretariat, { studentId: ids.sami, amount: 200_000, method: "cash" });
    expect(paid.status).toBe(201);
    const decided = await h.call("POST", `/api/automations/proposals/${proposal!.id}/decision`, secretariat, { approve: true });
    expect(decided.status).toBe(200);
    expect(decided.body.result.results).toEqual([
      { studentId: ids.rim, status: "sent" },
      { studentId: ids.sami, status: "nothing_due" },
    ]);
    expect(mailer.sent.map((m) => m.to)).toEqual(["rim@example.tn"]);
    const audit = await h.db
      .selectFrom("audit_log")
      .select(["user_id", "reason"])
      .where("action", "=", "reminders.sent")
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    expect(audit.reason).toBe("relances proposées par l'automatisation hebdomadaire");
    expect(audit.user_id).not.toBeNull();
    expect((await h.call("POST", `/api/automations/proposals/${proposal!.id}/decision`, secretariat, { approve: true })).body.code).toBe("proposal_closed");
    const history = await h.call("GET", "/api/automations/proposals?status=decided", secretariat);
    expect(history.body[0]).toMatchObject({ id: proposal!.id, status: "confirmed", decidedByName: "secretariat user" });
  });

  it("in auto mode, e-mail at once but leave out who was reminded recently", async () => {
    await setting("overdue_reminders", "auto", { weekday: 1, hour: 9, minDaysBetween: 7 });
    // The following Monday, 2 November at 09:30: Rim's reminder of Tuesday 27 October is less than seven days old.
    await h.db
      .updateTable("mail_dispatches")
      .set({ sent_at: new Date("2026-10-27T10:00:00Z") })
      .where("student_id", "=", ids.rim)
      .execute();
    expect(await run("2026-11-02T08:30:00Z")).toBe(1);
    const last = (await runsOf("overdue_reminders")).at(-1);
    expect(last).toMatchObject({ mode: "auto", status: "done", summary: { students: 0, skipped: { noRecipient: 1, remindedRecently: 1, belowMinimum: 0 } } });
    expect(mailer.sent).toHaveLength(0);
    // A week later Rim is due again; the e-mail leaves without anyone confirming, under no user.
    expect(await run("2026-11-09T08:30:00Z")).toBe(1);
    expect(mailer.sent.map((m) => m.to)).toEqual(["rim@example.tn"]);
    const audit = await h.db
      .selectFrom("audit_log")
      .select(["user_id", "reason"])
      .where("action", "=", "reminders.sent")
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    expect(audit).toEqual({ user_id: null, reason: "relance hebdomadaire automatique" });
    await setting("overdue_reminders", "off");
  });

  it("record a failed run when e-mail is not configured", async () => {
    await setting("overdue_reminders", "auto", { weekday: 1, hour: 9, minDaysBetween: 1 });
    expect(await runDueAutomations(h.db, null, silent, new Date("2026-11-16T08:30:00Z"))).toBe(1);
    const runs = await runsOf("overdue_reminders");
    expect(runs.at(-1)).toMatchObject({ status: "failed", error: "outgoing e-mail is not configured on this server" });
    await setting("overdue_reminders", "off");
  });
});

describe("monthly payroll", () => {
  it("proposes last month's pay with its warnings, and an accountant confirms the calculation", async () => {
    await setting("payroll_month", "propose", { day: 2, hour: 7, notifyRoles: ["accountant"] });
    // Monday 2 November, 09:00 in Tunis: October is calculated.
    expect(await run("2026-11-02T08:00:00Z")).toBe(1);
    const [proposal] = await pending(accountant);
    expect(proposal).toMatchObject({ kind: "payroll.calculate", title: "Paie d'octobre 2026 : 1 intervenant, 30,000 TND" });
    expect(proposal!.summary.instructors).toEqual([{ instructorId: ids.karim, name: "Karim Prof", items: 1, total: 30_000 }]);
    expect(proposal!.summary.warnings).toEqual([expect.objectContaining({ instructorId: ids.lina, name: "Lina Prof", code: "no_rule" })]);
    expect(mailer.sent.map((m) => m.to)).toEqual(["compta@auto.tn"]);
    expect(mailer.sent[0]!.text).toContain("confirmez-la dans Propositions");
    expect(mailer.sent[0]!.text).toContain("Lina Prof, Physique B");
    // Nothing is stored before the confirmation.
    expect(await h.db.selectFrom("pay_items").select("id").where("status", "=", "calculated").execute()).toHaveLength(0);
    expect(await pending(secretariat)).toHaveLength(0);
    const decided = await h.call("POST", `/api/automations/proposals/${proposal!.id}/decision`, accountant, { approve: true });
    expect(decided.body).toMatchObject({ status: "confirmed", result: { month: "2026-10", created: 1 } });
    const items = await h.db
      .selectFrom("pay_items")
      .select(["instructor_id", "amount", "status", "calculated_by"])
      .where("status", "=", "calculated")
      .execute();
    expect(items).toEqual([{ instructor_id: ids.karim, amount: 30_000, status: "calculated", calculated_by: expect.any(String) }]);
    await setting("payroll_month", "off");
  });

  it("in auto mode, stores the calculated items without validating them", async () => {
    await h.db
      .updateTable("pay_items")
      .set({ status: "cancelled", cancelled_at: new Date(), cancel_reason: "test" })
      .where("status", "=", "calculated")
      .execute();
    await h.db.updateTable("pay_item_sessions").set({ active: false }).execute();
    await setting("payroll_month", "auto", { day: 2, hour: 7, notifyRoles: [] });
    await forgetRuns("payroll_month");
    expect(await run("2026-11-02T08:00:00Z")).toBe(1);
    const items = await h.db.selectFrom("pay_items").select(["amount", "status", "calculated_by"]).where("status", "in", ["calculated", "validated"]).execute();
    expect(items).toEqual([{ amount: 30_000, status: "calculated", calculated_by: null }]);
    expect(mailer.sent).toHaveLength(0);
    await setting("payroll_month", "off");
  });
});

describe("proposals", () => {
  it("can be rejected with a note, and a newer one replaces a pending one of the same kind", async () => {
    await setting("overdue_reminders", "propose", { weekday: 1, hour: 9, minDaysBetween: 1 });
    await forgetRuns("overdue_reminders");
    await run("2026-11-23T08:30:00Z");
    const [first] = await pending(secretariat);
    await run("2026-11-30T08:30:00Z");
    const [second, ...rest] = await pending(secretariat);
    expect(rest).toHaveLength(0);
    expect(second!.id).not.toBe(first!.id);
    const old = await h.db.selectFrom("proposals").select("status").where("id", "=", first!.id).executeTakeFirstOrThrow();
    expect(old.status).toBe("expired");
    const rejected = await h.call("POST", `/api/automations/proposals/${second!.id}/decision`, secretariat, { approve: false, note: "Relance par téléphone" });
    expect(rejected.body).toEqual({ id: second!.id, status: "rejected", result: null });
    expect(mailer.sent).toHaveLength(0);
    await setting("overdue_reminders", "off");
  });
});

describe("automatic mail notice", () => {
  it("tells a domiciled member at reception, and leaves a member without e-mail to the desk", async () => {
    const plan = (
      await h.call("POST", "/api/coworking/plans", admin, {
        name: "Domiciliation",
        period: "month",
        price: 100_000,
        billing: "upfront",
        includesDomiciliation: true,
      })
    ).body.id;
    const member = async (firstName: string, email: string) =>
      (await h.call("POST", "/api/coworking/members", secretariat, { kind: "member", firstName, lastName: "Client", email })).body.id as string;
    const withMail = await member("Yasmine", "yasmine@client.tn");
    const withoutMail = await member("Hedi", "hedi@client.tn");
    for (const memberId of [withMail, withoutMail]) {
      const sold = await h.call("POST", "/api/coworking/subscriptions", secretariat, { memberId, planId: plan, startsOn: "2026-10-20" });
      expect(sold.status, JSON.stringify(sold.body)).toBe(201);
    }
    const before = await h.call("POST", "/api/coworking/mail-items", secretariat, { memberId: withMail, kind: "letter" });
    expect(before.body).toMatchObject({ status: "received", notice: null });

    await setting("mail_item_notice", "auto");
    mailer.sent.length = 0;
    const told = await h.call("POST", "/api/coworking/mail-items", secretariat, { memberId: withMail, kind: "parcel", sender: "Aramex" });
    expect(told.body).toMatchObject({ status: "notified", notice: "sent" });
    expect(mailer.sent.map((m) => [m.to, m.subject])).toEqual([["yasmine@client.tn", "Centre de test : du courrier vous attend"]]);
    expect(mailer.sent[0]!.text).toContain("un colis de la part de Aramex");
    const audit = await h.db
      .selectFrom("audit_log")
      .select(["user_id", "reason"])
      .where("action", "=", "cw_mail_item.notified")
      .where("object_id", "=", told.body.id)
      .executeTakeFirstOrThrow();
    expect(audit).toEqual({ user_id: null, reason: "avis automatique à la réception" });

    // A member record without an address (older data): the item is recorded and left for the desk.
    await h.db.updateTable("members").set({ email: null }).where("id", "=", withoutMail).execute();
    const desk = await h.call("POST", "/api/coworking/mail-items", secretariat, { memberId: withoutMail, kind: "letter" });
    expect(desk.status).toBe(201);
    expect(desk.body).toMatchObject({ status: "received", notice: "no_recipient" });
    await setting("mail_item_notice", "off");
  });
});
