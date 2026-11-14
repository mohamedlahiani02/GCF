import { addDays, addMonthsClamped } from "@gcf/shared";
import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import { createProposal } from "../domain/automations/proposals.js";
import { computeCandidates, monthBounds } from "../domain/payrollCalc.js";
import { overdueByStudent } from "../domain/reminders.js";
import type { Call } from "./seedDemo.js";

interface Context {
  call: Call;
  publicCall: Call | null;
  db: Kysely<Database>;
  centreId: string;
  today: string;
  start: string;
  end: string;
  password: string;
}

/** Completes the standard dataset with open AXELIA demonstration journeys through the regular API. */
export async function seedAxeliaExtras({ call, publicCall, db, centreId, today, start, end, password }: Context): Promise<void> {
  if (!publicCall) throw new Error("PUBLIC_ORIGIN is required for the AXELIA portal accounts");
  await call("PUT", "/cash/opening", { day: today, amount: 100_000 });
  await call("PUT", "/cafe/opening", { day: today, amount: 50_000 });

  for (const [email, fullName, role] of [
    ["secretariat@axelia.demo.test", "Accueil AXELIA", "secretariat"],
    ["comptable@axelia.demo.test", "Comptabilité AXELIA", "accountant"],
    ["editeur@axelia.demo.test", "Édition du site AXELIA", "editor"],
  ] as const) {
    await call("POST", "/users", { email, fullName, role, password });
  }

  const rooms = await db.selectFrom("rooms").select(["id", "name"]).where("centre_id", "=", centreId).execute();
  const classroom = rooms.find((room) => room.name === "Salle 1")!;
  const computers = rooms.find((room) => room.name === "Salle informatique")!;
  const teachers = await db.selectFrom("instructors").select(["id", "first_name"]).where("centre_id", "=", centreId).execute();
  const mathsTeacher = teachers.find((teacher) => teacher.first_name === "Sana")!;
  const webTeacher = teachers.find((teacher) => teacher.first_name === "Leila")!;
  const maths = await db.selectFrom("subjects").select("id").where("centre_id", "=", centreId).where("name", "=", "Mathématiques").executeTakeFirstOrThrow();
  const study = await call("POST", "/catalogue/studies", {
    subjectId: maths.id,
    name: "Mathématiques – 3e année secondaire",
    billingMode: "monthly",
    price: 80_000,
    absenceBilled: true,
    sessionsPerWeek: 1,
    capacity: 12,
  });
  const monthlyEnd = await call("POST", `/catalogue/studies/${study.id}/plans`, {
    name: "Mensuel – fin de mois",
    isDefault: true,
    kind: "monthly",
    amount: 80_000,
    monthlyDueKind: "month_end",
  });
  const monthlyStart = await call("POST", `/catalogue/studies/${study.id}/plans`, {
    name: "Mensuel – début de mois",
    isDefault: false,
    kind: "monthly",
    amount: 80_000,
    monthlyDueKind: "month_start",
  });
  const training = await call("POST", "/catalogue/trainings", {
    title: "Développement web",
    category: "Numérique",
    description: "HTML, CSS, JavaScript et réalisation d’une application web.",
    durationHours: 60,
    price: 650_000,
    capacity: 12,
  });
  const full = await call("POST", `/catalogue/trainings/${training.id}/plans`, { name: "Paiement intégral", isDefault: true, kind: "full", amount: 620_000 });
  const installments = await call("POST", `/catalogue/trainings/${training.id}/plans`, {
    name: "Deux tranches",
    isDefault: false,
    kind: "installments",
    items: [
      { label: "Inscription", valueKind: "percent", value: 5000, dueKind: "relative", dueOffsetDays: 0 },
      { label: "Solde", valueKind: "percent", value: 5000, dueKind: "relative", dueOffsetDays: 45 },
    ],
  });
  const monthly = await call("POST", `/catalogue/trainings/${training.id}/plans`, {
    name: "Mensuel – fin de mois",
    isDefault: false,
    kind: "monthly",
    amount: 180_000,
    monthlyDueKind: "month_end",
  });
  const trainingSession = await call("POST", `/catalogue/trainings/${training.id}/sessions`, { name: "Session automne", startDate: start, endDate: end });
  const studyEnd = addDays(addMonthsClamped(today, 3, 1), -1);
  const studyGroup = await call("POST", "/groups", {
    kind: "study",
    studyId: study.id,
    name: "Mathématiques – 3e année secondaire – Groupe A",
    instructorId: mathsTeacher.id,
    roomId: classroom.id,
    startDate: start,
    endDate: studyEnd,
    slots: [{ weekday: 5, startTime: "16:00", endTime: "18:00" }],
  });
  const webGroup = await call("POST", "/groups", {
    kind: "training",
    trainingSessionId: trainingSession.id,
    name: "Développement web – Groupe A",
    instructorId: webTeacher.id,
    roomId: computers.id,
    startDate: start,
    endDate: end,
    slots: [{ weekday: 3, startTime: "17:00", endTime: "19:00" }],
  });
  const students: { id: string; groupId: string }[] = [];
  for (const [index, [firstName, lastName]] of [
    ["Lina", "Belleval"],
    ["Louay", "Varnel"],
    ["Elyes", "Mireval"],
    ["Hana", "Dorvane"],
    ["Yara", "Calienne"],
    ["Adem", "Vernelle"],
    ["Amin", "Orvane"],
    ["Inès", "Belmont"],
    ["Sofiane", "Clairvel"],
    ["Manel", "Sorvane"],
  ].entries()) {
    const minor = index < 6;
    const email = `apprenant${index + 15}@axelia.demo.test`;
    const student = await call("POST", "/students", {
      firstName,
      lastName,
      email,
      phone: `21 100 ${String(300 + index)}`,
      isMinor: minor,
      ...(minor
        ? { guardianName: `Responsable ${lastName}`, guardianPhone: `21 200 ${String(300 + index)}`, guardianEmail: `famille${index + 15}@axelia.demo.test` }
        : {}),
    });
    const groupId = minor ? studyGroup.id : webGroup.id;
    const planId = minor ? (index < 3 ? monthlyEnd.id : monthlyStart.id) : index === 6 ? full.id : index === 9 ? monthly.id : installments.id;
    await call("POST", "/enrolments", {
      studentId: student.id,
      groupId,
      planId,
      effectiveDate: index === 5 ? today : start,
      ...(index === 8 ? { discount: { kind: "amount", value: 30_000, reason: "Remise de lancement AXELIA" } } : {}),
    });
    students.push({ id: student.id, groupId });
  }
  for (const [groupId, lastDay] of [
    [studyGroup.id, studyEnd],
    [webGroup.id, end],
  ]) {
    await call("POST", `/groups/${groupId}/sessions/generate`, { from: start, to: lastDay });
    const sessions = await call<{ id: string; startsAt: string }[]>("GET", `/groups/${groupId}/sessions?from=${start}&to=${today}`);
    const past = sessions.filter((session) => new Date(session.startsAt).getTime() < Date.now());
    for (const session of past.slice(0, -1)) await call("POST", `/sessions/${session.id}/validate`);
  }
  await call("POST", "/payments", { studentId: students[0]!.id, amount: 30_000, method: "cash" });
  await call("POST", "/payments", { studentId: students[6]!.id, amount: 700_000, method: "transfer", reference: "AX-WEB-AVANCE" });
  await call("POST", "/payments/refunds", {
    studentId: students[6]!.id,
    amount: 30_000,
    method: "transfer",
    reason: "Restitution partielle de l’avance disponible",
  });
  await call("POST", "/payments", { studentId: students[7]!.id, amount: 200_000, method: "card" });
  const cancelledPayment = await call<{ paymentId: string }>("POST", "/payments", { studentId: students[4]!.id, amount: 12_000, method: "cash" });
  await call("POST", `/payments/${cancelledPayment.paymentId}/cancel`, { reason: "Double saisie détectée au contrôle de caisse" });

  // Both portal journeys start with the same public sign-up flow a visitor uses.
  for (const [firstName, lastName, email, validate] of [
    ["Nadia", "Solvane", "client@axelia.demo.test", true],
    ["Adam", "Verlane", "inscription@axelia.demo.test", false],
  ] as const) {
    const response = await publicCall<{ status: string }>("POST", "/portal/auth/signup", { firstName, lastName, email, password, phone: "21 100 201" });
    const member = await db.selectFrom("members").select("id").where("centre_id", "=", centreId).where("email", "=", email).executeTakeFirstOrThrow();
    if (validate && response.status === "pending") await call("POST", `/coworking/members/${member.id}/validate`);
  }
  for (const [firstName, lastName, email] of [
    ["Salma", "Ornelle", "salma@axelia.demo.test"],
    ["Idriss", "Malvane", "idriss@axelia.demo.test"],
  ]) {
    await call("POST", "/coworking/members", { kind: "member", firstName, lastName, email, phone: "21 100 202" });
  }

  // Room 1 is free in these morning slots, outside the teaching timetable.
  await call("PUT", `/rooms/${classroom.id}/rates`, {
    rates: [
      { unit: "hour", amount: 40_000 },
      { unit: "month", amount: 300_000 },
    ],
  });
  const renters = [];
  for (const [name, email] of [
    ["Association Asterelle", "association@axelia.demo.test"],
    ["Studio Miravelle", "studio@axelia.demo.test"],
    ["Atelier Clairmont", "atelier@axelia.demo.test"],
  ]) {
    renters.push(await call("POST", "/renters", { name, email, phone: "71 100 200" }));
  }
  const firstDate = addDays(today, 3);
  await call("POST", "/rentals", {
    renterId: renters[0]!.id,
    roomId: classroom.id,
    unit: "hour",
    slots: [{ date: firstDate, startTime: "08:00", endTime: "10:00" }],
    paymentMode: "deposit_balance",
    deposit: 30_000,
    notes: "Atelier associatif, solde à encaisser le jour de la location",
  });
  await call("POST", "/payments", { renterId: renters[0]!.id, amount: 30_000, method: "cash" });
  await call("POST", "/rentals", {
    renterId: renters[1]!.id,
    roomId: classroom.id,
    unit: "month",
    periods: 2,
    slots: [
      { date: addDays(today, 5), startTime: "08:00", endTime: "10:00" },
      { date: addDays(today, 12), startTime: "08:00", endTime: "10:00" },
    ],
    paymentMode: "recurring",
    notes: "Créneaux récurrents pour un studio partenaire",
  });
  const cancelled = await call("POST", "/rentals", {
    renterId: renters[2]!.id,
    roomId: classroom.id,
    unit: "hour",
    slots: [{ date: addDays(today, 6), startTime: "08:00", endTime: "10:00" }],
    paymentMode: "full",
  });
  await call("POST", `/rentals/${cancelled.id}/cancel`, { reason: "L’événement a été annulé par l’organisateur" });

  const products = await call<{ id: string; name: string; stockQuantity: number }[]>("GET", "/cafe/products");
  const water = products.find((product) => product.name.startsWith("Eau"))!;
  const croissant = products.find((product) => product.name === "Croissant")!;
  const express = products.find((product) => product.name === "Café express")!;
  await call("POST", `/cafe/products/${croissant.id}/stock`, { kind: "loss", quantity: 1, reason: "Produit abîmé lors de la mise en place" });
  await call("POST", `/cafe/products/${croissant.id}/stock`, {
    kind: "count",
    counted: croissant.stockQuantity - 2,
    reason: "Comptage physique de démonstration",
  });
  const suppliers = await call<{ id: string }[]>("GET", "/cafe/suppliers");
  await call("PUT", "/cafe/settings", {
    openingFloat: 50_000,
    allowNegativeStock: false,
    ticketPrefix: "CAF",
    ticketPrinting: "browser",
    purchasing: "orders",
  });
  const order = await call("POST", "/cafe/purchase-orders", {
    supplierId: suppliers[0]!.id,
    note: "Livraison à réceptionner pendant la démonstration",
    lines: [
      { productId: water.id, quantity: 24, unitCost: 550 },
      { productId: croissant.id, quantity: 15, unitCost: 950 },
    ],
  });
  await call("POST", `/cafe/purchase-orders/${order.id}/send`);
  const sale = await call("POST", "/cafe/sales", {
    lines: [{ productId: express.id, quantity: 1 }],
    method: "cash",
    expectedTotal: 2_500,
    cashReceived: 5_000,
  });
  await call("POST", `/cafe/sales/${sale.id}/cancel`, { reason: "Erreur de sélection du produit au comptoir" });

  const yesterday = addDays(today, -1);
  await call("PUT", "/cash/opening", { day: yesterday, amount: 100_000 });
  await call("POST", "/cash/closings", { day: yesterday, countedCash: 100_000 });
  await call("PUT", "/cafe/opening", { day: yesterday, amount: 50_000 });
  await call("POST", "/cafe/closings", { day: yesterday, countedCash: 50_000 });

  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay() || 7;
  await call("PUT", "/automations/settings/overdue_reminders", { mode: "propose", params: { weekday, hour: 0, minDaysBetween: 7, minAmount: 10_000 } });
  await call("PUT", "/automations/settings/payroll_month", { mode: "propose", params: { day: 1, hour: 0, notifyRoles: [] } });
  await call("PUT", "/automations/settings/daily_digest", { mode: "off", params: {} });
  await call("PUT", "/automations/settings/mail_item_notice", { mode: "off", params: {} });
  await prepareAxeliaProposals(db, centreId, today);

  const token = await call("POST", "/integrations/tokens", { name: "n8n — exemple de jeton révoqué", role: "secretariat", readOnly: true });
  await call("POST", `/integrations/tokens/${token.id}/revoke`);
  const webhook = await call("POST", "/integrations/webhooks", {
    name: "n8n — workflow de test à connecter",
    url: "http://127.0.0.1:5678/webhook/axelia-demo",
    events: ["student.created"],
    maxAttempts: 3,
  });
  await call("PATCH", `/integrations/webhooks/${webhook.id}`, { active: false });
}

/** Uses current balances and payroll candidates to prepare the manual decisions shown during the demo. */
export async function prepareAxeliaProposals(db: Kysely<Database>, centreId: string, today: string): Promise<void> {
  const overdue = await overdueByStudent(db, centreId);
  const selected = overdue.filter((student) => student.recipient && student.total >= 10_000);
  if (selected.length) {
    const total = selected.reduce((sum, student) => sum + student.total, 0);
    await createProposal(db, {
      centreId,
      kind: "reminders.send",
      title: `Relances AXELIA à confirmer — ${selected.length} élèves`,
      summary: {
        total,
        students: selected.map((student) => ({
          studentId: student.studentId,
          name: `${student.firstName} ${student.lastName}`,
          recipient: student.recipient,
          total: student.total,
          oldestDueDate: student.items[0]!.dueDate,
          installments: student.items.length,
        })),
        skipped: {
          noRecipient: overdue.filter((student) => !student.recipient).length,
          remindedRecently: 0,
          belowMinimum: overdue.filter((student) => student.total < 10_000).length,
        },
      },
      payload: { studentIds: selected.map((student) => student.studentId) },
      runId: null,
    });
  }
  const month = today.slice(0, 7);
  const bounds = monthBounds(month);
  const { candidates, warnings } = await computeCandidates(db, centreId, { from: bounds.start, to: bounds.end, excludeValidated: true });
  const names = await db.selectFrom("instructors").select(["id", "first_name", "last_name"]).where("centre_id", "=", centreId).execute();
  const nameOf = (id: string) => {
    const teacher = names.find((row) => row.id === id)!;
    return `${teacher.first_name} ${teacher.last_name}`;
  };
  const instructors = [...new Set(candidates.map((candidate) => candidate.instructorId))].map((id) => {
    const items = candidates.filter((candidate) => candidate.instructorId === id);
    return { instructorId: id, name: nameOf(id), items: items.length, total: items.reduce((sum, item) => sum + item.amount, 0) };
  });
  if (instructors.length) {
    await createProposal(db, {
      centreId,
      kind: "payroll.calculate",
      title: `Calcul de paie AXELIA à confirmer — ${month}`,
      summary: {
        month,
        total: instructors.reduce((sum, row) => sum + row.total, 0),
        instructors,
        warnings: warnings.map((warning) => ({ ...warning, name: nameOf(warning.instructorId) })),
      },
      payload: { month, instructorIds: instructors.map((teacher) => teacher.instructorId) },
      runId: null,
    });
  }
}
