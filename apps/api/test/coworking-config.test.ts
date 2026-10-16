import { addDays, todayIn } from "@gcf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
let admin: string;
let secretariat: string;
let accountant: string;
const ids: Record<string, string> = {};
const today = todayIn("Africa/Tunis");

beforeAll(async () => {
  h = await createHarness();
  await h.createUser("admin", "admin@cfg.tn");
  await h.createUser("secretariat", "sec@cfg.tn");
  await h.createUser("accountant", "compta@cfg.tn");
});

afterAll(async () => {
  await h.close();
});

describe("coworking configuration", () => {
  it("answers 403 while the coworking module is disabled", async () => {
    const trainingOnly = await h.login("admin@cfg.tn");
    expect((await h.call("GET", "/api/coworking/settings", trainingOnly)).status).toBe(403);
    expect((await h.call("POST", "/api/coworking/floors", trainingOnly, { name: "RDC" })).status).toBe(403);
    await h.setModules(["training", "coworking"]);
    admin = await h.login("admin@cfg.tn");
    secretariat = await h.login("sec@cfg.tn");
    accountant = await h.login("compta@cfg.tn");
  });

  it("creates the rules with their defaults and validates ranges", async () => {
    const initial = await h.call("GET", "/api/coworking/settings", accountant);
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ bookingHorizonDays: 30, approvalMode: "visitors", selfSignup: "validated", offpeakFrom: null, portalEnabled: false });
    const updated = await h.call("PUT", "/api/coworking/settings", admin, { bookingHorizonDays: 60, offpeakFrom: "18:00", noShowGraceMinutes: null });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ bookingHorizonDays: 60, offpeakFrom: "18:00", noShowGraceMinutes: null });
    expect((await h.call("PUT", "/api/coworking/settings", admin, { lateCancelFeeBp: 10_001 })).status).toBe(400);
    expect((await h.call("PUT", "/api/coworking/settings", secretariat, { bookingHorizonDays: 10 })).status).toBe(403);
  });

  it("manages floors, zones, attributes, types and resources", async () => {
    ids.floor1 = (await h.call("POST", "/api/coworking/floors", admin, { name: "Rez-de-chaussée" })).body.id;
    ids.floor2 = (await h.call("POST", "/api/coworking/floors", admin, { name: "Étage 1", position: 1 })).body.id;
    expect((await h.call("POST", "/api/coworking/floors", admin, { name: "rez-de-chaussée" })).status).toBe(409);
    expect((await h.call("POST", "/api/coworking/floors", accountant, { name: "Sous-sol" })).status).toBe(403);
    const zone = await h.call("POST", "/api/coworking/zones", admin, { floorId: ids.floor1, name: "Open space", color: "#2563EB" });
    expect(zone.status).toBe(201);
    expect(zone.body.color).toBe("#2563eb");
    ids.zone1 = zone.body.id;
    ids.zone2 = (await h.call("POST", "/api/coworking/zones", admin, { floorId: ids.floor2, name: "Calme" })).body.id;
    ids.screen = (await h.call("POST", "/api/coworking/attributes", admin, { name: "Écran" })).body.id;
    ids.hotDesk = (await h.call("POST", "/api/coworking/resource-types", admin, { name: "Poste flexible", category: "hot_desk" })).body.id;
    ids.meeting = (
      await h.call("POST", "/api/coworking/resource-types", admin, { name: "Salle de réunion", category: "meeting_room", bufferMinutes: 15 })
    ).body.id;
    ids.dedicated = (await h.call("POST", "/api/coworking/resource-types", admin, { name: "Bureau dédié", category: "dedicated_desk" })).body.id;

    const desk = await h.call("POST", "/api/coworking/resources", admin, {
      code: "A-1",
      typeId: ids.hotDesk,
      floorId: ids.floor1,
      zoneId: ids.zone1,
      attributeIds: [ids.screen],
    });
    expect(desk.status).toBe(201);
    expect(desk.body).toMatchObject({ code: "A-1", floorName: "Rez-de-chaussée", zoneName: "Open space", attributeIds: [ids.screen], status: "active" });
    ids.desk = desk.body.id;
    expect((await h.call("POST", "/api/coworking/resources", admin, { code: "a-1", typeId: ids.hotDesk, floorId: ids.floor1 })).body.code).toBe("code_taken");
    const wrongZone = await h.call("POST", "/api/coworking/resources", admin, { code: "A-2", typeId: ids.hotDesk, floorId: ids.floor1, zoneId: ids.zone2 });
    expect(wrongZone.body.code).toBe("unknown_zone");
    ids.desk2 = (await h.call("POST", "/api/coworking/resources", admin, { code: "A-2", typeId: ids.hotDesk, floorId: ids.floor1 })).body.id;

    const room = (await h.call("POST", "/api/catalogue/rooms", admin, { name: "Salle Carthage", capacity: 12 })).body.id;
    const meeting = await h.call("POST", "/api/coworking/resources", admin, {
      code: "R-1",
      typeId: ids.meeting,
      floorId: ids.floor2,
      capacity: 12,
      roomId: room,
    });
    expect(meeting.status).toBe(201);
    expect(meeting.body.roomName).toBe("Salle Carthage");
    ids.room1 = meeting.body.id;
    const twice = await h.call("POST", "/api/coworking/resources", admin, { code: "R-2", typeId: ids.meeting, floorId: ids.floor2, roomId: room });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe("room_linked");

    const typeChange = await h.call("PATCH", `/api/coworking/resource-types/${ids.hotDesk}`, admin, { category: "private_office" });
    expect(typeChange.body.code).toBe("category_locked");
    expect((await h.call("GET", "/api/coworking/resources?floorId=" + ids.floor1, secretariat)).body).toHaveLength(2);
  });

  it("validates, saves and publishes a floor layout", async () => {
    const item = (resourceId: string, x: number) => ({ resourceId, x, y: 0.2, w: 0.05, h: 0.05, rotation: 0, shape: "rect" });
    const foreign = await h.call("PUT", `/api/coworking/floors/${ids.floor1}/draft-layout`, admin, { items: [item(ids.room1, 0.1)] });
    expect(foreign.status).toBe(422);
    expect(foreign.body).toMatchObject({ code: "unknown_plan_resource", details: { resourceIds: [ids.room1] } });
    const badZone = await h.call("PUT", `/api/coworking/floors/${ids.floor1}/draft-layout`, admin, {
      items: [],
      areas: [
        {
          zoneId: ids.zone2,
          points: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        },
      ],
    });
    expect(badZone.body.code).toBe("unknown_plan_zone");
    expect((await h.call("PUT", `/api/coworking/floors/${ids.floor1}/draft-layout`, admin, { items: [{ resourceId: ids.desk }] })).body.code).toBe(
      "invalid_layout",
    );
    expect((await h.call("POST", `/api/coworking/floors/${ids.floor1}/publish`, admin)).body.code).toBe("no_draft");

    const saved = await h.call("PUT", `/api/coworking/floors/${ids.floor1}/draft-layout`, admin, {
      items: [item(ids.desk, 0.1), item(ids.desk2, 0.3)],
      labels: [{ text: "Accueil", x: 0.5, y: 0.9, size: "m" }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.draftLayout.aspect).toBe(1.6);
    const published = await h.call("POST", `/api/coworking/floors/${ids.floor1}/publish`, admin);
    expect(published.status).toBe(200);
    const floor = await h.call("GET", `/api/coworking/floors/${ids.floor1}`, accountant);
    expect(floor.body.layout.items).toHaveLength(2);
    expect(floor.body.draftLayout).toBeNull();
    expect(floor.body.layoutPublishedBy).toBe("admin user");
    expect(floor.body.resources.map((r: { code: string }) => r.code)).toEqual(["A-1", "A-2"]);

    const move = await h.call("PATCH", `/api/coworking/resources/${ids.desk2}`, admin, { floorId: ids.floor2 });
    expect(move.status).toBe(409);
    expect(move.body.code).toBe("resource_on_plan");
    const media = await h.call("PUT", `/api/coworking/floors/${ids.floor1}/plan`, admin, { mediaId: "00000000-0000-4000-8000-000000000000" });
    expect(media.body.code).toBe("unknown_media");
  });

  it("reports future bookings when a resource leaves service and refuses to archive it", async () => {
    const startsAt = new Date(Date.now() + 2 * 86_400_000);
    const endsAt = new Date(startsAt.getTime() + 3_600_000);
    await h.db
      .insertInto("cw_bookings")
      .values({
        centre_id: h.centreId,
        kind: "block",
        resource_id: ids.desk,
        starts_at: startsAt,
        ends_at: endsAt,
        blocked_until: endsAt,
        status: "confirmed",
        source: "staff",
        notes: "travaux",
      })
      .execute();
    const off = await h.call("POST", `/api/coworking/resources/${ids.desk}/status`, admin, { status: "out_of_service", reason: "Chaise cassée" });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ status: "out_of_service", outOfServiceReason: "Chaise cassée", futureBookings: 1 });
    expect((await h.call("POST", `/api/coworking/resources/${ids.desk}/status`, admin, { status: "out_of_service" })).status).toBe(400);
    const archive = await h.call("POST", `/api/coworking/resources/${ids.desk}/archive`, admin, { reason: "Retiré" });
    expect(archive.status).toBe(409);
    expect(archive.body).toMatchObject({ code: "resource_has_bookings", details: { count: 1 } });
    const typeArchive = await h.call("POST", `/api/coworking/resource-types/${ids.hotDesk}/archive`, admin, { reason: "Fin" });
    expect(typeArchive.body).toMatchObject({ code: "resource_has_bookings", details: { count: 1 } });

    const archived = await h.call("POST", `/api/coworking/resources/${ids.desk2}/archive`, admin, { reason: "Retiré" });
    expect(archived.status).toBe(200);
    const floor = await h.call("GET", `/api/coworking/floors/${ids.floor1}`, admin);
    expect(floor.body.layout.items.map((i: { resourceId: string }) => i.resourceId)).toEqual([ids.desk]);
  });

  it("maps format rules to explicit errors and replaces prices", async () => {
    const fixed = { typeId: ids.meeting, label: "1 heure", nature: "fixed", durationMinutes: 60 };
    expect((await h.call("POST", "/api/coworking/formats", admin, fixed)).body.code).toBe("format_step_invalid");
    expect((await h.call("POST", "/api/coworking/formats", admin, { ...fixed, startStepMinutes: 30, startTime: "09:00" })).body.code).toBe(
      "format_fields_mismatch",
    );
    const created = await h.call("POST", "/api/coworking/formats", admin, { ...fixed, startStepMinutes: 30, weekdays: [5, 1, 1] });
    expect(created.status).toBe(201);
    expect(created.body.weekdays).toEqual([1, 5]);
    ids.format = created.body.id;
    const named = { typeId: ids.meeting, label: "Matinée", nature: "named", startTime: "13:00", endTime: "09:00" };
    expect((await h.call("POST", "/api/coworking/formats", admin, named)).body.code).toBe("format_hours_invalid");
    const free = { typeId: ids.hotDesk, label: "Libre", nature: "free", minMinutes: 60, maxMinutes: 30, startStepMinutes: 30 };
    expect((await h.call("POST", "/api/coworking/formats", admin, free)).body.code).toBe("format_range_invalid");
    const dedicated = await h.call("POST", "/api/coworking/formats", admin, { ...fixed, typeId: ids.dedicated, startStepMinutes: 60 });
    expect(dedicated.body.code).toBe("type_not_bookable");
    const changed = await h.call("PATCH", `/api/coworking/formats/${ids.format}`, admin, { durationMinutes: 120 });
    expect(changed.body).toMatchObject({ durationMinutes: 120, startStepMinutes: 30 });

    const prices = await h.call("PUT", `/api/coworking/formats/${ids.format}/prices`, admin, {
      prices: [
        { profile: "visitor", amount: 30_000, offpeakAmount: 20_000 },
        { profile: "member", amount: 20_000, offpeakAmount: null },
      ],
    });
    expect(prices.status).toBe(200);
    expect(prices.body.prices).toEqual([
      { profile: "visitor", amount: 30_000, offpeakAmount: 20_000 },
      { profile: "member", amount: 20_000, offpeakAmount: null },
    ]);
    const duplicate = await h.call("PUT", `/api/coworking/formats/${ids.format}/prices`, admin, {
      prices: [
        { profile: "visitor", amount: 1, offpeakAmount: null },
        { profile: "visitor", amount: 2, offpeakAmount: null },
      ],
    });
    expect(duplicate.body.code).toBe("duplicate_profile");
  });

  it("records closures and reduced hours", async () => {
    const bad = await h.call("POST", "/api/coworking/closures", admin, {
      startsOn: addDays(today, 5),
      endsOn: addDays(today, 5),
      label: "Demi-journée",
      openFrom: "14:00",
    });
    expect(bad.body.code).toBe("closure_hours_invalid");
    const created = await h.call("POST", "/api/coworking/closures", admin, { startsOn: addDays(today, 5), endsOn: addDays(today, 6), label: "Aïd" });
    expect(created.status).toBe(201);
    await h.call("POST", "/api/coworking/closures", admin, { startsOn: addDays(today, -20), endsOn: addDays(today, -19), label: "Passé" });
    const list = await h.call("GET", "/api/coworking/closures", secretariat);
    expect(list.body.map((c: { label: string }) => c.label)).toEqual(["Aïd"]);
    expect((await h.call("DELETE", `/api/coworking/closures/${created.body.id}`, secretariat)).status).toBe(403);
    expect((await h.call("DELETE", `/api/coworking/closures/${created.body.id}`, admin)).status).toBe(204);
  });

  it("validates plans, entitlements, pack products and promotion codes", async () => {
    const base = { name: "Nomade", period: "month", price: 150_000, billing: "upfront" };
    expect((await h.call("POST", "/api/coworking/plans", admin, { ...base, billing: "monthly" })).body.code).toBe("monthly_billing_period");
    const unlimitedQuota = await h.call("POST", "/api/coworking/plans", admin, {
      ...base,
      entitlements: [{ typeId: ids.meeting, quotaKind: "unlimited", quota: 10 }],
    });
    expect(unlimitedQuota.body.code).toBe("invalid_quota");
    expect((await h.call("POST", "/api/coworking/plans", admin, { ...base, assignedTypeId: ids.hotDesk })).body.code).toBe("not_assigned_type");
    const plan = await h.call("POST", "/api/coworking/plans", admin, {
      ...base,
      entitlements: [
        { typeId: ids.hotDesk, quotaKind: "unlimited", quota: null },
        { typeId: ids.meeting, quotaKind: "minutes", quota: 240 },
      ],
    });
    expect(plan.status).toBe(201);
    expect(plan.body.entitlements).toHaveLength(2);
    const replaced = await h.call("PATCH", `/api/coworking/plans/${plan.body.id}`, admin, {
      entitlements: [{ typeId: ids.meeting, quotaKind: "bookings", quota: 4 }],
    });
    expect(replaced.body.entitlements).toEqual([{ typeId: ids.meeting, typeName: "Salle de réunion", quotaKind: "bookings", quota: 4 }]);
    const resident = await h.call("POST", "/api/coworking/plans", admin, {
      name: "Résident",
      period: "quarter",
      price: 900_000,
      billing: "monthly",
      assignedTypeId: ids.dedicated,
    });
    expect(resident.status).toBe(201);

    const packType = await h.call("POST", "/api/coworking/pack-products", admin, {
      name: "10 h bureau",
      typeId: ids.dedicated,
      quotaKind: "minutes",
      quota: 600,
      validityDays: 90,
      price: 80_000,
    });
    expect(packType.body.code).toBe("pack_type_invalid");
    const pack = await h.call("POST", "/api/coworking/pack-products", admin, {
      name: "10 h salle",
      typeId: ids.meeting,
      quotaKind: "minutes",
      quota: 600,
      validityDays: 90,
      price: 80_000,
    });
    expect(pack.status).toBe(201);

    const promo = { code: "bienvenue-26", kind: "percent", value: 1_500, validFrom: today, validTo: addDays(today, 30) };
    const created = await h.call("POST", "/api/coworking/promo-codes", admin, promo);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ code: "BIENVENUE-26", uses: 0, profiles: ["visitor", "member"] });
    expect((await h.call("POST", "/api/coworking/promo-codes", admin, promo)).body.code).toBe("code_taken");
    expect((await h.call("POST", "/api/coworking/promo-codes", admin, { ...promo, code: "AUTRE", value: 12_000 })).body.code).toBe("invalid_percent");
    expect((await h.call("POST", "/api/coworking/promo-codes", admin, { ...promo, code: "A!" })).body.code).toBe("invalid_promo_code");
    expect((await h.call("POST", "/api/coworking/promo-codes", secretariat, { ...promo, code: "SEC" })).status).toBe(403);
  });
});
