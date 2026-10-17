/**
 * Fills an empty centre with a realistic demonstration dataset for each module it runs. Training: rooms,
 * instructors, private lessons ("cours particuliers"), trainings with several formulas, groups and their sessions,
 * enrolments, attendance, payments, pay rules and pay items at every stage (calculated, validated, settled in full or
 * in part). Coworking and website: see seedDemoCoworking.ts and seedDemoWebsite.ts.
 *
 * Everything goes through the HTTP API as the given administrator, so every business rule and every audit entry
 * applies exactly as in daily use. Dates are relative to today: the groups start on the first day of last month.
 *
 * Usage: pnpm --filter @gcf/api seed:demo -- --email admin@centre.tn
 */
import { parseArgs } from "node:util";
import { addDays, addMonthsClamped } from "@gcf/shared";
import { buildApp, SESSION_COOKIE } from "../app.js";
import { createSession, deleteSession } from "../auth/sessions.js";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { centreClock } from "../domain/ledger.js";
import { seedCoworking } from "./seedDemoCoworking.js";
import { seedWebsite } from "./seedDemoWebsite.js";

type Method = "GET" | "POST" | "PUT" | "PATCH";
export type Call = <T = { id: string }>(method: Method, url: string, payload?: unknown) => Promise<T>;

interface GroupSession {
  id: string;
  startsAt: string;
  status: string;
  sheetStatus: string;
}
interface PayItem {
  id: string;
  kind: string;
  status: string;
  dueOn: string;
  amount: number;
  remaining: number;
  label: string;
}

const { values } = parseArgs({ options: { email: { type: "string" } } });
if (!values.email) {
  console.error("usage: seed:demo --email <administrator e-mail>");
  process.exit(2);
}

const config = loadConfig();
const db = createDb(config.databaseUrl);
let sessionId: string | undefined;

try {
  const admin = await db
    .selectFrom("users")
    .select(["id", "centre_id as centreId", "role", "active"])
    .where("email", "=", values.email.trim().toLowerCase())
    .executeTakeFirst();
  if (!admin || admin.role !== "admin" || !admin.active) throw new Error("no active administrator with this e-mail");
  const { modules } = await db.selectFrom("centres").select("modules").where("id", "=", admin.centreId).executeTakeFirstOrThrow();
  const training = modules.includes("training");
  const existing = training && (await db.selectFrom("students").select("id").where("centre_id", "=", admin.centreId).executeTakeFirst());
  if (existing) throw new Error("this centre already has students: demonstration data only goes into an empty centre");

  const app = await buildApp({ config, db, rateLimit: false, mailer: null });
  const token = await createSession(db, admin.id, { idleMinutes: config.sessionIdleMinutes, absoluteHours: config.sessionAbsoluteHours }, "seed:demo");
  sessionId = (
    await db
      .selectFrom("sessions")
      .select("id")
      .where("user_id", "=", admin.id)
      .where("user_agent", "=", "seed:demo")
      .orderBy("created_at", "desc")
      .executeTakeFirstOrThrow()
  ).id;
  const call: Call = async (method, url, payload) => {
    const response = await app.inject({
      method,
      url: `/api${url}`,
      headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: config.webOrigin },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    if (response.statusCode >= 300) throw new Error(`${method} ${url} answered ${response.statusCode}: ${response.body}`);
    return response.json();
  };
  const publicOrigin = config.publicOrigin;
  const publicCall: Call | null = publicOrigin
    ? async (method, url, payload) => {
        const response = await app.inject({
          method,
          url: `/api${url}`,
          headers: { origin: publicOrigin, host: new URL(publicOrigin).host },
          ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
        });
        if (response.statusCode >= 300) throw new Error(`${method} ${url} answered ${response.statusCode}: ${response.body}`);
        return response.json();
      }
    : null;

  const { today } = await centreClock(db, admin.centreId);
  const start = addMonthsClamped(today, -1, 1);
  const end = addDays(addMonthsClamped(today, 4, 1), -1);
  const lastMonth = start.slice(0, 7);
  const thisMonth = today.slice(0, 7);

  if (training) await seedTraining();
  if (modules.includes("coworking")) {
    await seedCoworking({ call, db, centreId: admin.centreId, userId: admin.id, today });
    console.log("coworking demonstration data created");
  }
  if (modules.includes("website")) {
    await seedWebsite({ call, publicCall, db, centreId: admin.centreId, today, coworking: modules.includes("coworking") });
    console.log(publicCall ? "website demonstration data created" : "website demonstration data created, without visitor requests (PUBLIC_ORIGIN is not set)");
  }

  async function seedTraining(): Promise<void> {
    const room = async (name: string, capacity: number) => (await call("POST", "/catalogue/rooms", { name, capacity })).id;
    const rooms = {
      one: await room("Salle 1", 20),
      two: await room("Salle 2", 14),
      sewing: await room("Atelier couture", 10),
      computers: await room("Salle informatique", 12),
    };
    const subject = async (name: string) => (await call("POST", "/catalogue/subjects", { name })).id;
    const subjects = { maths: await subject("Mathématiques"), french: await subject("Français"), english: await subject("Anglais") };

    const instructor = async (firstName: string, lastName: string, kind: "teacher" | "trainer", employment: string, subjectIds: string[]) =>
      (await call("POST", "/instructors", { firstName, lastName, kind, employment, subjectIds, availability: [] })).id;
    const people = {
      sana: await instructor("Sana", "Ben Salah", "teacher", "contractor", [subjects.maths]),
      ines: await instructor("Ines", "Gharbi", "teacher", "salaried", [subjects.french]),
      hichem: await instructor("Hichem", "Jaziri", "teacher", "freelance", [subjects.english]),
      karim: await instructor("Karim", "Trabelsi", "trainer", "freelance", []),
      leila: await instructor("Leila", "Mansour", "trainer", "contractor", []),
    };

    const study = async (
      subjectId: string,
      name: string,
      billingMode: "monthly" | "per_session",
      price: number,
      absenceBilled: boolean,
      sessionsPerWeek: number,
    ) => (await call("POST", "/catalogue/studies", { subjectId, name, billingMode, price, absenceBilled, sessionsPerWeek, capacity: 12 })).id;
    const studies = {
      maths: await study(subjects.maths, "Maths Bac", "monthly", 80_000, true, 2),
      french: await study(subjects.french, "Français 9e année", "per_session", 15_000, false, 1),
      english: await study(subjects.english, "Anglais conversation", "monthly", 60_000, true, 1),
    };

    const sewing = (
      await call("POST", "/catalogue/trainings", { title: "Couture et modélisme", category: "Métiers", durationHours: 120, price: 900_000, capacity: 10 })
    ).id;
    const office = (
      await call("POST", "/catalogue/trainings", { title: "Bureautique", category: "Informatique", durationHours: 40, price: 300_000, capacity: 12 })
    ).id;
    const plan = async (trainingId: string, body: Record<string, unknown>) => (await call("POST", `/catalogue/trainings/${trainingId}/plans`, body)).id;
    const formulas = {
      sewingInstallments: await plan(sewing, {
        name: "40 / 30 / 30",
        isDefault: true,
        kind: "installments",
        items: [
          { label: "Inscription", valueKind: "percent", value: 4000, dueKind: "relative", dueOffsetDays: 0 },
          { label: "Deuxième tranche", valueKind: "percent", value: 3000, dueKind: "relative", dueOffsetDays: 30 },
          { label: "Solde", valueKind: "percent", value: 3000, dueKind: "relative", dueOffsetDays: 60 },
        ],
      }),
      sewingFull: await plan(sewing, { name: "Paiement intégral", isDefault: false, kind: "full", amount: 850_000 }),
      sewingMonthly: await plan(sewing, { name: "Mensuel", isDefault: false, kind: "monthly", amount: 230_000 }),
      officeFull: await plan(office, { name: "Paiement intégral", isDefault: true, kind: "full" }),
      officePerSession: await plan(office, { name: "À la séance", isDefault: false, kind: "per_session", amount: 20_000, absenceBilled: false }),
    };
    const trainingSession = async (trainingId: string) =>
      (await call("POST", `/catalogue/trainings/${trainingId}/sessions`, { name: "Session de rentrée", startDate: start, endDate: end })).id;
    const sessions = { sewing: await trainingSession(sewing), office: await trainingSession(office) };

    const slot = (weekday: number, startTime: string, endTime: string) => ({ weekday, startTime, endTime });
    const group = async (body: Record<string, unknown>) => (await call("POST", "/groups", { startDate: start, endDate: end, ...body })).id;
    const groups = {
      mathsA: await group({
        kind: "study",
        studyId: studies.maths,
        name: "Maths Bac A",
        instructorId: people.sana,
        roomId: rooms.one,
        slots: [slot(2, "14:00", "16:00"), slot(6, "09:00", "11:00")],
      }),
      mathsB: await group({
        kind: "study",
        studyId: studies.maths,
        name: "Maths Bac B",
        instructorId: people.sana,
        roomId: rooms.one,
        slots: [slot(4, "16:00", "18:00")],
      }),
      french: await group({
        kind: "study",
        studyId: studies.french,
        name: "Français 9e A",
        instructorId: people.ines,
        roomId: rooms.two,
        slots: [slot(3, "14:00", "15:30")],
      }),
      english: await group({
        kind: "study",
        studyId: studies.english,
        name: "Anglais A",
        instructorId: people.hichem,
        roomId: rooms.two,
        slots: [slot(6, "11:00", "12:30")],
      }),
      sewing: await group({
        kind: "training",
        trainingSessionId: sessions.sewing,
        name: "Couture A",
        instructorId: people.karim,
        roomId: rooms.sewing,
        slots: [slot(1, "09:00", "12:00"), slot(4, "09:00", "12:00")],
      }),
      office: await group({
        kind: "training",
        trainingSessionId: sessions.office,
        name: "Bureautique A",
        instructorId: people.leila,
        roomId: rooms.computers,
        slots: [slot(2, "17:00", "19:00")],
      }),
    };

    const student = async (firstName: string, lastName: string, extra: Record<string, unknown> = {}) =>
      (await call("POST", "/students", { firstName, lastName, ...extra })).id;
    const minor = (guardianName: string, guardianPhone: string) => ({ isMinor: true, guardianName, guardianPhone });
    const pupils = {
      amira: await student("Amira", "Chebbi", minor("Mourad Chebbi", "22 334 455")),
      omar: await student("Omar", "Ayadi", minor("Faten Ayadi", "98 112 233")),
      yasmine: await student("Yasmine", "Karray", minor("Nabil Karray", "55 667 788")),
      youssef: await student("Youssef", "Mejri", minor("Hela Mejri", "20 445 566")),
      mariem: await student("Mariem", "Sellami", minor("Ridha Sellami", "29 778 899")),
      aziz: await student("Aziz", "Haddad", minor("Samia Haddad", "24 556 677")),
      eya: await student("Eya", "Zouari", minor("Kamel Zouari", "50 223 344")),
      rayen: await student("Rayen", "Bouzid", minor("Olfa Bouzid", "92 334 112")),
      salma: await student("Salma", "Trabelsi", { phone: "21 998 877" }),
      nour: await student("Nour", "Ben Amor", { phone: "26 554 433" }),
      hamza: await student("Hamza", "Feki", { phone: "97 221 100" }),
      rania: await student("Rania", "Dridi", { phone: "52 887 766" }),
      walid: await student("Walid", "Masmoudi", { phone: "23 665 544" }),
      khadija: await student("Khadija", "Ghanmi", { phone: "58 443 322" }),
    };

    const enrol = (studentId: string, groupId: string, terms: Record<string, unknown>) =>
      call("POST", "/enrolments", { studentId, groupId, effectiveDate: start, ...terms });
    const enrolments: [string, string, Record<string, unknown>][] = [
      [pupils.amira, groups.mathsA, { paymentMode: "monthly" }],
      [pupils.omar, groups.mathsA, { paymentMode: "monthly" }],
      [pupils.yasmine, groups.mathsA, { paymentMode: "monthly" }],
      [pupils.youssef, groups.mathsA, { paymentMode: "monthly" }],
      [pupils.mariem, groups.mathsA, { paymentMode: "monthly" }],
      [pupils.aziz, groups.mathsB, { paymentMode: "monthly" }],
      [pupils.eya, groups.mathsB, { paymentMode: "monthly" }],
      [pupils.rayen, groups.mathsB, { paymentMode: "monthly" }],
      [pupils.amira, groups.french, { paymentMode: "per_session" }],
      [pupils.eya, groups.french, { paymentMode: "per_session" }],
      [pupils.rayen, groups.french, { paymentMode: "per_session" }],
      [pupils.omar, groups.english, { paymentMode: "monthly" }],
      [pupils.mariem, groups.english, { paymentMode: "monthly" }],
      [pupils.salma, groups.sewing, { planId: formulas.sewingInstallments }],
      [pupils.nour, groups.sewing, { planId: formulas.sewingInstallments }],
      [pupils.rania, groups.sewing, { planId: formulas.sewingMonthly }],
      [pupils.khadija, groups.sewing, { planId: formulas.sewingFull }],
      [pupils.hamza, groups.office, { planId: formulas.officeFull }],
      [pupils.walid, groups.office, { planId: formulas.officePerSession }],
      [pupils.nour, groups.office, { planId: formulas.officePerSession }],
    ];
    for (const [studentId, groupId, terms] of enrolments) await enrol(studentId, groupId, terms);

    // Sessions over the whole period. Past sessions are held, with a few absences; the last past session of Maths
    // Bac A is left for the secretariat to take attendance, and one English session was cancelled.
    const now = Date.now();
    for (const [key, groupId] of Object.entries(groups)) {
      await call("POST", `/groups/${groupId}/sessions/generate`, { from: start, to: end });
      const list = await call<GroupSession[]>("GET", `/groups/${groupId}/sessions?from=${start}&to=${today}`);
      const past = list.filter((s) => s.status !== "cancelled" && new Date(s.startsAt).getTime() < now);
      const enrolled = enrolments.filter(([, g]) => g === groupId).map(([studentId]) => studentId);
      for (const [index, session] of past.entries()) {
        if (key === "mathsA" && index === past.length - 1) continue;
        if (key === "english" && index === 1) {
          await call("POST", `/sessions/${session.id}/cancel`, { reason: "Enseignant malade, séance reportée" });
          continue;
        }
        const records = enrolled.flatMap((studentId, j) =>
          (index * 3 + j) % 7 === 0 ? [{ studentId, status: (index + j) % 2 === 0 ? "absent_justified" : "absent" }] : [],
        );
        if (records.length) await call("PUT", `/sessions/${session.id}/attendance`, { records });
        await call("POST", `/sessions/${session.id}/validate`);
      }
    }

    // Collections: most families are up to date for last month, a few owe money.
    const pay = (studentId: string, amount: number, method: string, extra: Record<string, unknown> = {}) =>
      call("POST", "/payments", { studentId, amount, method, ...extra });
    await pay(pupils.amira, 80_000, "cash");
    await pay(pupils.omar, 140_000, "cash");
    await pay(pupils.yasmine, 160_000, "transfer", { reference: "VIR-0412" });
    await pay(pupils.youssef, 80_000, "cash");
    await pay(pupils.aziz, 80_000, "cheque", { cheque: { number: "0045812", bank: "BIAT" } });
    await pay(pupils.eya, 110_000, "cash");
    await pay(pupils.salma, 360_000, "cheque", { cheque: { number: "1120034", bank: "STB" } });
    await pay(pupils.nour, 360_000, "transfer", { reference: "VIR-0419" });
    await pay(pupils.rania, 230_000, "cash");
    await pay(pupils.khadija, 850_000, "transfer", { reference: "VIR-0420" });
    await pay(pupils.hamza, 150_000, "card");
    await pay(pupils.walid, 40_000, "cash");

    // Pay rules: one rule per rhythm, and two distinct rules for the same instructor.
    const rule = (instructorId: string, body: Record<string, unknown>) => call("POST", "/payroll/rules", { instructorId, validFrom: start, ...body });
    await rule(people.sana, { scope: "instructor", baseKind: "pct_collections", basisPoints: 5000, collectionBasis: "invoiced", presenceKind: "prorata" });
    await rule(people.sana, { scope: "group", scopeId: groups.mathsB, baseKind: "fixed_per_session", amount: 35_000, presenceKind: "ignore" });
    await rule(people.ines, { scope: "instructor", baseKind: "monthly_flat", amount: 450_000, presenceKind: "ignore" });
    await rule(people.hichem, { scope: "instructor", baseKind: "hourly", amount: 18_000, presenceKind: "ignore", periodicity: "session" });
    await rule(people.karim, { scope: "group", scopeId: groups.sewing, baseKind: "training_flat", amount: 1_500_000, presenceKind: "ignore" });
    await rule(people.leila, { scope: "instructor", baseKind: "fixed_per_session", amount: 30_000, presenceKind: "prorata" });

    const payOf = async (instructorId: string, month: string) =>
      (await call<{ items: PayItem[] }>("GET", `/payroll/instructors/${instructorId}?month=${month}`)).items;
    for (const instructorId of Object.values(people)) {
      await call("POST", "/payroll/calculate", { instructorId, month: lastMonth });
      await call("POST", "/payroll/calculate", { instructorId, month: thisMonth });
    }
    await call("POST", "/payroll/adjustments", {
      instructorId: people.ines,
      month: lastMonth,
      kind: "bonus",
      amount: 50_000,
      reason: "Préparation des examens blancs",
    });

    const validateDue = async (instructorId: string) => {
      const items = [...(await payOf(instructorId, lastMonth)), ...(await payOf(instructorId, thisMonth))];
      const due = items.filter((i) => i.status === "calculated" && i.dueOn <= today);
      if (due.length) await call("POST", "/payroll/items/validate", { itemIds: due.map((i) => i.id) });
      return (await payOf(instructorId, thisMonth)).filter((i) => i.status === "validated" && i.remaining !== 0);
    };
    const settle = (instructorId: string, method: string, lines: { itemId: string; amount: number }[]) =>
      call("POST", "/payroll/settlements", { instructorId, paidOn: today, method, lines });

    // Sana: last month settled in full. Ines: flat and bonus paid in part. Hichem: two sessions paid. Leila:
    // validated, waiting to be paid. Karim: his training flat is due at the end of the group only.
    const sana = await validateDue(people.sana);
    if (sana.length)
      await settle(
        people.sana,
        "transfer",
        sana.map((i) => ({ itemId: i.id, amount: i.remaining })),
      );
    const ines = await validateDue(people.ines);
    const inesFlat = ines.find((i) => i.kind === "rule");
    if (inesFlat) await settle(people.ines, "cash", [{ itemId: inesFlat.id, amount: 300_000 }]);
    const hichem = await validateDue(people.hichem);
    if (hichem.length)
      await settle(
        people.hichem,
        "cash",
        hichem.slice(0, 2).map((i) => ({ itemId: i.id, amount: i.remaining })),
      );
    await validateDue(people.leila);

    console.log(`training demonstration data created from ${start} to ${end}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (sessionId) await deleteSession(db, sessionId);
  await db.destroy();
}
