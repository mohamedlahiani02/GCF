import { todayIn } from "@gcf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
let admin: string;
let secretariat: string;
let accountant: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  h = await createHarness();
  await h.createUser("admin", "admin@loc.tn");
  await h.createUser("secretariat", "sec@loc.tn");
  await h.createUser("accountant", "compta@loc.tn");
  admin = await h.login("admin@loc.tn");
  secretariat = await h.login("sec@loc.tn");
  accountant = await h.login("compta@loc.tn");
  ids.roomA = (await h.call("POST", "/api/catalogue/rooms", admin, { name: "Salle A", capacity: 20 })).body.id;
  ids.roomB = (await h.call("POST", "/api/catalogue/rooms", admin, { name: "Salle B", capacity: 12 })).body.id;
  await h.call("PUT", `/api/rooms/${ids.roomA}/rates`, admin, {
    rates: [
      { unit: "hour", amount: 25_000 },
      { unit: "day", amount: 150_000 },
      { unit: "month", amount: 1_800_000 },
    ],
  });
  await h.call("PUT", `/api/rooms/${ids.roomB}/rates`, admin, {
    rates: [
      { unit: "hour", amount: 18_000 },
      { unit: "month", amount: 1_300_000 },
    ],
  });
  ids.medis = (
    await h.call("POST", "/api/renters", secretariat, { name: "Société Medis", company: "Medis SARL", phone: "71 555 000", email: "contact@medis.example" })
  ).body.id;
  ids.amal = (await h.call("POST", "/api/renters", secretariat, { name: "Association Al Amal" })).body.id;
  const subject = (await h.call("POST", "/api/catalogue/subjects", admin, { name: "Physique" })).body.id;
  const teacher = (
    await h.call("POST", "/api/instructors", admin, {
      firstName: "Rami",
      lastName: "Dridi",
      kind: "teacher",
      employment: "contractor",
      subjectIds: [],
      availability: [],
    })
  ).body.id;
  const study = (
    await h.call("POST", "/api/catalogue/studies", admin, {
      subjectId: subject,
      name: "Physique 3e",
      billingMode: "monthly",
      price: 35_000,
      absenceBilled: true,
      sessionsPerWeek: 1,
      capacity: 10,
    })
  ).body.id;
  ids.group = (
    await h.call("POST", "/api/groups", secretariat, {
      kind: "study",
      studyId: study,
      name: "Groupe B",
      instructorId: teacher,
      roomId: ids.roomA,
      startDate: "2026-10-01",
      endDate: "2026-12-31",
      slots: [{ weekday: 4, startTime: "16:00", endTime: "18:00" }],
    })
  ).body.id;
  await h.call("POST", `/api/groups/${ids.group}/sessions/generate`, secretariat, { from: "2026-11-01", to: "2026-11-30" });
});

afterAll(async () => {
  await h.close();
});

describe("rentals", () => {
  it("prices from the room grid and checks conflicts before saving", async () => {
    const preview = await h.call("POST", "/api/rentals/preview", secretariat, {
      renterId: ids.medis,
      roomId: ids.roomA,
      unit: "hour",
      slots: [{ date: "2026-11-05", startTime: "16:00", endTime: "18:00" }],
      paymentMode: "deposit_balance",
      deposit: 20_000,
    });
    expect(preview.status).toBe(200);
    expect(preview.body.pricing).toEqual({ unitPrice: 25_000, quantity: 120, total: 50_000 });
    expect(preview.body.conflicts).toEqual([expect.objectContaining({ type: "room", description: "room used by Groupe B" })]);
    const refused = await h.call("POST", "/api/rentals", secretariat, {
      renterId: ids.medis,
      roomId: ids.roomA,
      unit: "hour",
      slots: [{ date: "2026-11-05", startTime: "16:00", endTime: "18:00" }],
      paymentMode: "full",
    });
    expect(refused.status).toBe(409);
  });

  it("books an hourly rental with a deposit and a balance", async () => {
    const res = await h.call("POST", "/api/rentals", secretariat, {
      renterId: ids.medis,
      roomId: ids.roomB,
      unit: "hour",
      slots: [{ date: "2026-11-05", startTime: "16:00", endTime: "18:00" }],
      paymentMode: "deposit_balance",
      deposit: 18_000,
    });
    expect(res.status).toBe(201);
    expect(res.body.schedule.map((l: { amount: number; dueDate: string }) => [l.amount, l.dueDate])).toEqual([
      // The deposit is due on the day of booking.
      [18_000, todayIn("Africa/Tunis")],
      [18_000, "2026-11-05"],
    ]);
    ids.hourly = res.body.id;
  });

  it("books a monthly rental on a weekly pattern with recurring payment", async () => {
    const res = await h.call("POST", "/api/rentals", secretariat, {
      renterId: ids.amal,
      roomId: ids.roomB,
      unit: "month",
      periods: 2,
      pattern: { from: "2026-11-09", to: "2026-12-31", weekdays: [1], startTime: "08:00", endTime: "12:00" },
      paymentMode: "recurring",
    });
    expect(res.status).toBe(201);
    expect(res.body.pricing).toEqual({ unitPrice: 1_300_000, quantity: 2, total: 2_600_000 });
    expect(res.body.schedule.map((l: { dueDate: string }) => l.dueDate)).toEqual(["2026-11-09", "2026-12-09"]);
    ids.monthly = res.body.id;
  });

  it("refuses a class session in a room that is rented", async () => {
    const res = await h.call("POST", `/api/groups/${ids.group}/sessions`, secretariat, {
      date: "2026-11-16",
      startTime: "09:00",
      endTime: "10:00",
      roomId: ids.roomB,
    });
    expect(res.status).toBe(409);
    expect(res.body.details.conflicts[0].description).toBe("room rented to Association Al Amal");
  });

  it("collects a renter payment with its own receipt", async () => {
    const res = await h.call("POST", "/api/payments", secretariat, { renterId: ids.medis, amount: 18_000, method: "cash" });
    expect(res.status).toBe(201);
    expect(res.body.after).toEqual({ due: 18_000, credit: 0, pendingDiscounts: 0 });
    const receipt = await h.call("GET", `/api/receipts/${res.body.receipt.id}`, secretariat);
    expect(receipt.body.snapshot.payer.name).toBe("Société Medis (Medis SARL)");
    const detail = await h.call("GET", `/api/rentals/${ids.hourly}`, accountant);
    expect(detail.body.schedule.map((s: { state: string }) => s.state)).toEqual(["paid", "upcoming"]);
    expect(detail.body.receipts).toHaveLength(1);
  });

  it("cancels a rental, frees its future slots and keeps money already received", async () => {
    const cancelled = await h.call("POST", `/api/rentals/${ids.hourly}/cancel`, secretariat, { reason: "Événement reporté" });
    expect(cancelled.body.cancelledInstallments).toBe(1);
    const free = await h.call("POST", `/api/groups/${ids.group}/sessions`, secretariat, {
      date: "2026-11-05",
      startTime: "16:30",
      endTime: "17:30",
      roomId: ids.roomB,
    });
    expect(free.status).toBe(409);
    expect(free.body.details.conflicts.map((c: { type: string }) => c.type)).toEqual(["group"]);
    const totals = (await h.call("GET", `/api/rentals/${ids.hourly}`, accountant)).body.renterTotals;
    expect(totals).toEqual({ due: 0, credit: 0, pendingDiscounts: 0 });
  });

  it("shows sessions and rentals together in the planning", async () => {
    const res = await h.call("GET", "/api/planning?from=2026-11-09&to=2026-11-15", accountant);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { type: string }) => i.type)).toEqual(["rental", "course"]);
  });

  it("produces a contract PDF and hides rental management from the accountant", async () => {
    const pdf = await h.app.inject({ method: "GET", url: `/api/rentals/${ids.monthly}/contract.pdf`, headers: { cookie: accountant } });
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    const write = await h.call("POST", "/api/renters", accountant, { name: "X" });
    expect(write.status).toBe(403);
  });
});
