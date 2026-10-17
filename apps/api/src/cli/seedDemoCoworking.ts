/**
 * Coworking part of the demonstration dataset: rules, a floor with its published plan, spaces and formats with
 * their prices, plans, packs and a promotion code, companies, members and a walk-in guest, subscriptions with
 * domiciliation mail, and bookings in every state (request waiting for a decision, confirmed, checked in today,
 * completed, cancelled, no-show), some of them paid at the desk so the cash page shows coworking takings.
 *
 * Configuration and current operations go through the HTTP API like the training data. Past bookings cannot be
 * created through the API (a slot that is over is refused), so they are created with the booking domain functions
 * at a reference time before the slot, checked in at the slot, then closed by the coworking sweeper: the same
 * business rules apply, only the clock differs.
 */
import { addDays, type FloorLayout } from "@gcf/shared";
import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import { checkIn, createBooking } from "../domain/coworking/bookings.js";
import { centreCalendar, openingsBetween } from "../domain/coworking/schedule.js";
import { sweepCoworking } from "../domain/coworking/sweeper.js";
import type { Call } from "./seedDemo.js";

interface Context {
  call: Call;
  db: Kysely<Database>;
  centreId: string;
  userId: string;
  today: string;
}

interface Booked {
  id: string;
  startsAt: string;
  endsAt: string;
  charge: number;
}

const HOUR = 3_600_000;

export async function seedCoworking({ call, db, centreId, userId, today }: Context): Promise<void> {
  const existing = await db.selectFrom("cw_resource_types").select("id").where("centre_id", "=", centreId).executeTakeFirst();
  if (existing) throw new Error("this centre already has coworking spaces: demonstration data only goes into an empty coworking");

  await call("PUT", "/coworking/settings", {
    bookingHorizonDays: 60,
    minNoticeMinutes: 30,
    maxActiveBookings: 10,
    approvalMode: "visitors",
    freeCancelHours: 24,
    lateCancelFeeBp: 5000,
    noShowGraceMinutes: 30,
    requestExpiryHours: 48,
    selfSignup: "validated",
    offpeakFrom: "18:00",
    portalEnabled: true,
  });

  const floor = (await call("POST", "/coworking/floors", { name: "Rez-de-chaussée" })).id;
  const zone = async (name: string, color: string) => (await call("POST", "/coworking/zones", { floorId: floor, name, color })).id;
  const zones = { open: await zone("Open space", "#2563eb"), quiet: await zone("Espace calme", "#0f766e"), offices: await zone("Bureaux", "#9333ea") };
  const attribute = async (name: string) => (await call("POST", "/coworking/attributes", { name })).id;
  const attributes = { screen: await attribute("Écran 27 pouces"), projector: await attribute("Vidéoprojecteur"), window: await attribute("Côté fenêtre") };

  const type = async (body: Record<string, unknown>) => (await call("POST", "/coworking/resource-types", body)).id;
  const types = {
    desk: await type({
      name: "Poste en open space",
      category: "hot_desk",
      description: "Un poste de travail dans l'open space, wifi et café compris.",
      requiresApproval: false,
      bufferMinutes: 0,
      position: 0,
      public: true,
    }),
    meeting: await type({
      name: "Salle de réunion",
      category: "meeting_room",
      description: "Salle équipée d'un écran et d'un tableau blanc.",
      requiresApproval: true,
      maxMinutesPerDay: 480,
      bufferMinutes: 15,
      position: 1,
      public: true,
    }),
    booth: await type({
      name: "Cabine téléphonique",
      category: "phone_booth",
      description: "Cabine isolée pour les appels et les visioconférences.",
      requiresApproval: false,
      maxMinutesPerDay: 120,
      bufferMinutes: 0,
      position: 2,
      public: true,
    }),
    office: await type({
      name: "Bureau privé",
      category: "private_office",
      description: "Bureau fermé attribué à l'année ou au mois.",
      position: 3,
      public: true,
    }),
  };

  const resource = async (code: string, typeId: string, zoneId: string, capacity: number, attributeIds: string[] = [], name?: string) =>
    (await call("POST", "/coworking/resources", { code, typeId, floorId: floor, zoneId, capacity, attributeIds, ...(name ? { name } : {}) })).id;
  const desks: string[] = [];
  for (let i = 1; i <= 8; i++)
    desks.push(
      await resource(`D-${String(i).padStart(2, "0")}`, types.desk, i <= 6 ? zones.open : zones.quiet, 1, i % 2 ? [attributes.screen] : [attributes.window]),
    );
  const rooms = {
    small: await resource("M-1", types.meeting, zones.quiet, 6, [attributes.screen], "Salle Carthage"),
    large: await resource("M-2", types.meeting, zones.quiet, 10, [attributes.projector, attributes.screen], "Salle Kairouan"),
  };
  const booth = await resource("C-1", types.booth, zones.quiet, 1);
  const offices = {
    one: await resource("B-1", types.office, zones.offices, 4, [attributes.window], "Bureau Hannibal"),
    two: await resource("B-2", types.office, zones.offices, 2, [], "Bureau Elyssa"),
  };

  // Plan coordinates are the centre of each shape; the layout below is drawn from top-left corners.
  const place = (resourceId: string, left: number, top: number, w: number, h: number, shape: "rect" | "ellipse" = "rect") => ({
    resourceId,
    x: left + w / 2,
    y: top + h / 2,
    w,
    h,
    rotation: 0,
    shape,
  });
  const layout: FloorLayout = {
    aspect: 1.6,
    items: [
      ...desks.slice(0, 6).map((id, i) => place(id, 0.06 + (i % 3) * 0.1, i < 3 ? 0.1 : 0.3, 0.07, 0.1)),
      ...desks.slice(6).map((id, i) => place(id, 0.06 + i * 0.1, 0.62, 0.07, 0.1)),
      place(rooms.small, 0.42, 0.08, 0.2, 0.28),
      place(rooms.large, 0.66, 0.08, 0.28, 0.28),
      place(booth, 0.42, 0.5, 0.08, 0.12, "ellipse"),
      place(offices.one, 0.56, 0.5, 0.18, 0.36),
      place(offices.two, 0.77, 0.5, 0.17, 0.36),
    ],
    labels: [
      { text: "Accueil", x: 0.2, y: 0.88, size: "m" },
      { text: "Cuisine", x: 0.06, y: 0.88, size: "s" },
    ],
    areas: [
      {
        zoneId: zones.open,
        points: [
          [0.03, 0.05],
          [0.36, 0.05],
          [0.36, 0.48],
          [0.03, 0.48],
        ],
      },
      {
        zoneId: zones.quiet,
        points: [
          [0.03, 0.56],
          [0.36, 0.56],
          [0.36, 0.78],
          [0.03, 0.78],
        ],
      },
      {
        zoneId: zones.offices,
        points: [
          [0.53, 0.46],
          [0.97, 0.46],
          [0.97, 0.9],
          [0.53, 0.9],
        ],
      },
    ],
  };
  await call("PUT", `/coworking/floors/${floor}/draft-layout`, layout);
  await call("POST", `/coworking/floors/${floor}/publish`);

  const calendar = await centreCalendar(db, centreId);
  const opensAt = calendar.openFrom;
  const closesAt = calendar.openTo;
  const middayHour = Math.floor((Number(opensAt.slice(0, 2)) * 60 + Number(closesAt.slice(0, 2)) * 60) / 120);
  const midday = `${String(middayHour).padStart(2, "0")}:00`;

  const format = async (typeId: string, body: Record<string, unknown>, visitor: number, member: number, offpeak: [number, number] | null = null) => {
    const id = (await call("POST", "/coworking/formats", { typeId, ...body })).id;
    await call("PUT", `/coworking/formats/${id}/prices`, {
      prices: [
        { profile: "visitor", amount: visitor, offpeakAmount: offpeak ? offpeak[0] : null },
        { profile: "member", amount: member, offpeakAmount: offpeak ? offpeak[1] : null },
      ],
    });
    return id;
  };
  const formats = {
    hour: await format(types.desk, { label: "1 heure", nature: "fixed", durationMinutes: 60, startStepMinutes: 60 }, 5_000, 4_000, [4_000, 3_000]),
    twoHours: await format(types.desk, { label: "2 heures", nature: "fixed", durationMinutes: 120, startStepMinutes: 60 }, 9_000, 7_000),
    threeHours: await format(types.desk, { label: "3 heures", nature: "fixed", durationMinutes: 180, startStepMinutes: 60 }, 12_000, 10_000),
    morning: await format(types.desk, { label: "Demi-journée matin", nature: "named", startTime: opensAt, endTime: midday }, 15_000, 12_000),
    afternoon: await format(types.desk, { label: "Demi-journée après-midi", nature: "named", startTime: midday, endTime: closesAt }, 15_000, 12_000),
    day: await format(types.desk, { label: "Journée", nature: "named", startTime: opensAt, endTime: closesAt }, 25_000, 20_000),
    meeting: await format(
      types.meeting,
      { label: "Au choix (30 min à 8 h)", nature: "free", minMinutes: 30, maxMinutes: 480, startStepMinutes: 30 },
      30_000,
      25_000,
    ),
    booth: await format(types.booth, { label: "30 minutes", nature: "fixed", durationMinutes: 30, startStepMinutes: 30 }, 3_000, 2_000),
  };

  const nextMonday = addDays(today, ((8 - isoWeekday(today)) % 7) + 7);
  await call("POST", "/coworking/closures", { startsOn: addDays(nextMonday, 14), endsOn: addDays(nextMonday, 14), label: "Inventaire annuel" });

  const plan = async (body: Record<string, unknown>) => (await call("POST", "/coworking/plans", body)).id;
  const plans = {
    resident: await plan({
      name: "Résident mensuel",
      description: "Accès illimité à l'open space et 4 heures de salle de réunion par mois.",
      period: "month",
      price: 250_000,
      billing: "upfront",
      includesDomiciliation: false,
      noticeDays: 7,
      public: true,
      position: 0,
      entitlements: [
        { typeId: types.desk, quotaKind: "unlimited", quota: null },
        { typeId: types.meeting, quotaKind: "minutes", quota: 240 },
      ],
    }),
    yearly: await plan({
      name: "Résident annuel",
      description: "Open space illimité toute l'année, réglé chaque mois.",
      period: "year",
      price: 2_400_000,
      billing: "monthly",
      includesDomiciliation: false,
      noticeDays: 30,
      public: true,
      position: 1,
      entitlements: [
        { typeId: types.desk, quotaKind: "unlimited", quota: null },
        { typeId: types.meeting, quotaKind: "minutes", quota: 480 },
      ],
    }),
    office: await plan({
      name: "Bureau privé mensuel",
      description: "Bureau fermé attribué, domiciliation et 8 heures de salle de réunion.",
      period: "month",
      price: 900_000,
      billing: "upfront",
      includesDomiciliation: true,
      assignedTypeId: types.office,
      noticeDays: 30,
      public: true,
      position: 2,
      entitlements: [{ typeId: types.meeting, quotaKind: "minutes", quota: 480 }],
    }),
    domiciliation: await plan({
      name: "Domiciliation",
      description: "Adresse commerciale et réception du courrier.",
      period: "year",
      price: 600_000,
      billing: "monthly",
      includesDomiciliation: true,
      noticeDays: 30,
      public: true,
      position: 3,
      entitlements: [{ typeId: types.meeting, quotaKind: "bookings", quota: 2 }],
    }),
  };
  const packProduct = (
    await call("POST", "/coworking/pack-products", {
      name: "10 heures d'open space",
      typeId: types.desk,
      quotaKind: "minutes",
      quota: 600,
      validityDays: 90,
      price: 40_000,
      public: true,
    })
  ).id;
  await call("POST", "/coworking/promo-codes", {
    code: "BIENVENUE",
    kind: "percent",
    value: 2000,
    validFrom: today,
    validTo: addDays(today, 90),
    maxUses: 50,
    profiles: ["visitor"],
  });

  const company = async (name: string, taxId: string, email: string) => (await call("POST", "/coworking/companies", { name, taxId, email })).id;
  const companies = {
    atlas: await company("Atlas Digital", "1456789/A/M/000", "contact@atlas-digital.example.com"),
    medina: await company("Medina Conseil", "1398765/B/N/000", "bonjour@medina-conseil.example.com"),
  };
  const member = async (firstName: string, lastName: string, email: string, phone: string, extra: Record<string, unknown> = {}) =>
    (await call("POST", "/coworking/members", { kind: "member", firstName, lastName, email, phone, ...extra })).id;
  const members = {
    sami: await member("Sami", "Ben Ali", "sami.benali@atlas-digital.example.com", "22 410 300", { companyId: companies.atlas, companyRole: "admin" }),
    meriem: await member("Meriem", "Jlassi", "meriem.jlassi@atlas-digital.example.com", "98 220 145", { companyId: companies.atlas, companyRole: "member" }),
    anis: await member("Anis", "Kooli", "anis.kooli@medina-conseil.example.com", "55 901 233", { companyId: companies.medina, companyRole: "admin" }),
    ons: await member("Ons", "Hammami", "ons.hammami@example.com", "29 117 880"),
    fares: await member("Farès", "Chaabane", "fares.chaabane@example.com", "21 665 409"),
    lina: await member("Lina", "Riahi", "lina.riahi@example.com", "50 334 712"),
  };
  const guest = (await call("POST", "/coworking/members", { kind: "guest", firstName: "Rim", lastName: "Saidi", phone: "97 450 128" })).id;

  const monthStart = `${today.slice(0, 7)}-01`;
  const subscribe = (memberId: string, planId: string, startsOn: string, extra: Record<string, unknown> = {}) =>
    call("POST", "/coworking/subscriptions", { memberId, planId, startsOn, ...extra });
  await subscribe(members.sami, plans.office, monthStart, { assignedResourceId: offices.one, autoRenew: true });
  await subscribe(members.meriem, plans.resident, monthStart, { autoRenew: true });
  await subscribe(members.anis, plans.domiciliation, monthStart);
  await subscribe(members.ons, plans.yearly, monthStart);
  await call("POST", "/coworking/packs", { memberId: members.fares, productId: packProduct });

  await call("POST", "/coworking/mail-items", {
    memberId: members.anis,
    kind: "registered",
    sender: "Recette des finances de Tunis",
    reference: "RR 4521 7789 TN",
  });
  await call("POST", "/coworking/mail-items", { memberId: members.anis, kind: "letter", sender: "Banque de Tunisie" });
  await call("POST", "/coworking/mail-items", { memberId: members.sami, kind: "parcel", sender: "Aramex", reference: "AX-889210" });

  // Past bookings over the last two weeks, created at a reference time two days before each slot.
  const pastDays = (await openingsBetween(db, centreId, addDays(today, -14), addDays(today, -1))).filter((d) => d.open !== null);
  const staff = { source: "staff" as const, userId };
  const past = [
    { memberId: members.meriem, resourceId: desks[0]!, formatId: formats.day, startTime: opensAt, arrived: true },
    { memberId: members.ons, resourceId: desks[1]!, formatId: formats.morning, startTime: opensAt, arrived: true },
    { memberId: members.fares, resourceId: desks[2]!, formatId: formats.twoHours, startTime: shift(opensAt, 2), arrived: true },
    { memberId: members.lina, resourceId: desks[3]!, formatId: formats.afternoon, startTime: midday, arrived: false },
    { memberId: members.sami, resourceId: rooms.large, formatId: formats.meeting, startTime: shift(opensAt, 2), durationMinutes: 120, arrived: true },
    { memberId: guest, resourceId: desks[4]!, formatId: formats.hour, startTime: shift(opensAt, 1), arrived: true },
  ];
  for (const [index, day] of pastDays.entries()) {
    const slot = past[index % past.length]!;
    const at = new Date(`${day.date}T12:00:00Z`).getTime() - 2 * 24 * HOUR;
    const { booking } = await createBooking(db, centreId, staff, { ...slot, date: day.date, override: true }, new Date(at));
    if (slot.arrived) await checkIn(db, centreId, { bookingId: booking.id }, { source: "staff", userId }, new Date(booking.startsAt.getTime() + 5 * 60_000));
  }
  await sweepCoworking(db);

  // Current and future operations through the API.
  const book = (memberId: string, resourceId: string, formatId: string, date: string, startTime: string, extra: Record<string, unknown> = {}) =>
    call<Booked>("POST", "/coworking/bookings", { memberId, resourceId, formatId, date, startTime, override: true, ...extra });
  // A full-day booking today, checked in when the centre is open right now.
  const [todayOpening] = await openingsBetween(db, centreId, today, today);
  const localTime = new Intl.DateTimeFormat("en-GB", { timeZone: calendar.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
  if (todayOpening?.open && todayOpening.open.from === opensAt && todayOpening.open.to === closesAt && localTime < closesAt) {
    const todays = await book(members.meriem, desks[0]!, formats.day, today, opensAt);
    if (localTime >= opensAt) await call("POST", `/coworking/bookings/${todays.id}/check-in`);
  }
  const tomorrow = (await openingsBetween(db, centreId, addDays(today, 1), addDays(today, 10))).find((d) => d.open !== null)!.date;
  const walkIn = await book(guest, desks[5]!, formats.afternoon, tomorrow, midday);
  await book(members.ons, desks[1]!, formats.morning, tomorrow, opensAt);
  await book(members.sami, rooms.small, formats.meeting, tomorrow, shift(opensAt, 1), { durationMinutes: 90, notes: "Réunion client, prévoir café" });
  const cancelled = await book(members.lina, desks[2]!, formats.threeHours, tomorrow, shift(opensAt, 2));
  await call("POST", `/coworking/bookings/${cancelled.id}/cancel`, { reason: "Déplacement imprévu" });
  await createBooking(
    db,
    centreId,
    { source: "portal", memberId: members.lina },
    {
      memberId: members.lina,
      resourceId: rooms.large,
      formatId: formats.meeting,
      date: tomorrow,
      startTime: shift(opensAt, 4),
      durationMinutes: 120,
      notes: "Atelier d'équipe",
    },
  );
  await call("POST", "/coworking/blocks", {
    resourceId: booth,
    startDate: tomorrow,
    startTime: opensAt,
    endDate: tomorrow,
    endTime: midday,
    reason: "Maintenance de l'isolation phonique",
  });

  // Desk payments today: the coworking takings of the cash page.
  await call("POST", "/payments", { memberId: members.sami, amount: 900_000, method: "transfer", reference: "VIR-CW-0101" });
  await call("POST", "/payments", { memberId: members.meriem, amount: 250_000, method: "cash" });
  await call("POST", "/payments", { memberId: members.fares, amount: 40_000, method: "card" });
  await call("POST", "/payments", { memberId: guest, amount: walkIn.charge, method: "cash" });
}

function isoWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** A clock time moved by whole hours, e.g. shift("08:00", 2) is "10:00". */
function shift(time: string, hours: number): string {
  const [h, m] = time.split(":").map(Number);
  return `${String(h! + hours).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
