import { ASSIGNED_CATEGORIES, CW_CATEGORIES, floorLayoutSchema, OCCUPYING_STATUSES, parseLayout, type FloorLayout } from "@gcf/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import { writeAudit } from "../../audit.js";
import type { SessionUser } from "../../auth/sessions.js";
import type { CwCategory, CwFormatNature } from "../../db/types.coworking.js";
import type { Database } from "../../db/types.js";
import { centreClock } from "../../domain/ledger.js";
import { conflict, HttpError, notFound, unprocessable } from "../../errors.js";
import { archiveBody, clockTime, idParam, isoDate, millimes, optionalText, reason, requiredText, toClock, uuid } from "../../validation.js";

type Db = Kysely<Database> | Transaction<Database>;

const statusQuery = z.object({ status: z.enum(["active", "archived", "all"]).default("active") });
const position = z.number().int().min(0).max(10_000);
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "expected #rrggbb")
  .transform((v) => v.toLowerCase());
const weekdays = z.array(z.number().int().min(1).max(7)).min(1).max(7);

const settingsBody = z
  .object({
    bookingHorizonDays: z.number().int().min(1).max(365),
    minNoticeMinutes: z.number().int().min(0).max(10_080),
    maxActiveBookings: z.number().int().min(1).max(100),
    approvalMode: z.enum(["none", "visitors", "all"]),
    freeCancelHours: z.number().int().min(0).max(720),
    lateCancelFeeBp: z.number().int().min(0).max(10_000),
    noShowGraceMinutes: z.number().int().min(5).max(240).nullable(),
    requestExpiryHours: z.number().int().min(1).max(720),
    selfSignup: z.enum(["open", "validated", "closed"]),
    offpeakFrom: clockTime.nullable(),
    portalEnabled: z.boolean(),
  })
  .partial()
  .strict();

const floorCreate = z.object({ name: requiredText(100), position: position.optional() }).strict();
const floorUpdate = z
  .object({ name: requiredText(100), position })
  .partial()
  .strict();
const planBody = z.object({ mediaId: uuid.nullable() }).strict();

const zoneCreate = z.object({ floorId: uuid, name: requiredText(100), color: color.optional() }).strict();
const zoneUpdate = z
  .object({ name: requiredText(100), color })
  .partial()
  .strict();
const zoneQuery = z.object({ floorId: uuid.optional(), status: z.enum(["active", "archived", "all"]).default("active") });

const attributeBody = z.object({ name: requiredText(100) }).strict();

const typeFields = {
  name: requiredText(100),
  category: z.enum(CW_CATEGORIES),
  description: optionalText(2000),
  photoMediaId: uuid.nullable().optional(),
  requiresApproval: z.boolean(),
  maxMinutesPerDay: z.number().int().min(15).max(1440).nullable(),
  bufferMinutes: z.number().int().min(0).max(240),
  position,
  public: z.boolean(),
};
const typeCreate = z.object(typeFields).partial().required({ name: true, category: true }).strict();
const typeUpdate = z.object(typeFields).partial().strict();

const resourceFields = {
  code: requiredText(20),
  name: optionalText(100),
  typeId: uuid,
  floorId: uuid,
  zoneId: uuid.nullable().optional(),
  capacity: z.number().int().min(1).max(500),
  attributeIds: z.array(uuid).max(50),
  roomId: uuid.nullable().optional(),
};
const resourceCreate = z.object(resourceFields).partial().required({ code: true, typeId: true, floorId: true }).strict();
const resourceUpdate = z.object(resourceFields).partial().strict();
const resourceQuery = z.object({
  floorId: uuid.optional(),
  typeId: uuid.optional(),
  zoneId: uuid.optional(),
  status: z.enum(["current", "active", "out_of_service", "archived", "all"]).default("current"),
});
const resourceStatusBody = z
  .object({ status: z.enum(["active", "out_of_service"]), reason: reason.optional() })
  .strict()
  .refine((b) => (b.status === "out_of_service") === (b.reason !== undefined), "a reason is required to put a resource out of service, and only then");

const formatFields = {
  label: requiredText(100),
  nature: z.enum(["fixed", "named", "free"]),
  durationMinutes: z.number().int().nullable().optional(),
  startStepMinutes: z.number().int().nullable().optional(),
  startTime: clockTime.nullable().optional(),
  endTime: clockTime.nullable().optional(),
  minMinutes: z.number().int().nullable().optional(),
  maxMinutes: z.number().int().nullable().optional(),
  weekdays: weekdays.optional(),
  position: position.optional(),
};
const formatCreate = z.object({ typeId: uuid, ...formatFields }).strict();
const formatUpdate = z.object(formatFields).partial().strict();
const formatQuery = z.object({ typeId: uuid.optional(), status: z.enum(["active", "archived", "all"]).default("active") });
const pricesBody = z
  .object({
    prices: z.array(z.object({ profile: z.enum(["visitor", "member"]), amount: millimes, offpeakAmount: millimes.nullable() }).strict()).max(2),
  })
  .strict();

const closureBody = z
  .object({ startsOn: isoDate, endsOn: isoDate, label: requiredText(100), openFrom: clockTime.nullable().optional(), openTo: clockTime.nullable().optional() })
  .strict();
const closureQuery = z.object({ from: isoDate.optional() });

const entitlementInput = z
  .object({ typeId: uuid, quotaKind: z.enum(["unlimited", "minutes", "bookings"]), quota: z.number().int().min(1).max(1_000_000).nullable() })
  .strict();
const planFields = {
  name: requiredText(100),
  description: optionalText(2000),
  period: z.enum(["month", "quarter", "year"]),
  price: millimes.min(1),
  billing: z.enum(["upfront", "monthly"]),
  includesDomiciliation: z.boolean(),
  assignedTypeId: uuid.nullable().optional(),
  noticeDays: z.number().int().min(0).max(365),
  public: z.boolean(),
  position,
  entitlements: z.array(entitlementInput).max(30),
};
const planCreate = z.object(planFields).partial().required({ name: true, period: true, price: true, billing: true }).strict();
const planUpdate = z.object(planFields).partial().strict();

const packFields = {
  name: requiredText(100),
  typeId: uuid,
  quotaKind: z.enum(["minutes", "bookings"]),
  quota: z.number().int().min(1).max(1_000_000),
  validityDays: z.number().int().min(1).max(1095),
  price: millimes.min(1),
  public: z.boolean(),
};
const packCreate = z
  .object(packFields)
  .partial()
  .required({ name: true, typeId: true, quotaKind: true, quota: true, validityDays: true, price: true })
  .strict();
const packUpdate = z.object(packFields).partial().strict();

const promoFields = {
  code: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase()),
  kind: z.enum(["percent", "amount"]),
  value: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  validFrom: isoDate,
  validTo: isoDate,
  maxUses: z.number().int().min(1).max(1_000_000).nullable().optional(),
  profiles: z
    .array(z.enum(["visitor", "member"]))
    .min(1)
    .max(2),
};
const promoCreate = z.object(promoFields).partial().required({ code: true, kind: true, value: true, validFrom: true, validTo: true }).strict();
const promoUpdate = z.object(promoFields).partial().strict();

const isAssigned = (category: CwCategory) => ASSIGNED_CATEGORIES.includes(category);

/** Occupying bookings of a resource, or of every resource of a type, that have not ended yet. */
async function futureBookingCount(db: Db, filter: { resourceId: string } | { typeId: string }): Promise<number> {
  const row = await db
    .selectFrom("cw_bookings")
    .innerJoin("cw_resources", "cw_resources.id", "cw_bookings.resource_id")
    .select(sql<number>`count(*)::integer`.as("n"))
    .where("cw_bookings.status", "in", [...OCCUPYING_STATUSES])
    .where("cw_bookings.blocked_until", ">", sql<Date>`now()`)
    .$if("resourceId" in filter, (qb) => qb.where("cw_resources.id", "=", (filter as { resourceId: string }).resourceId))
    .$if("typeId" in filter, (qb) => qb.where("cw_resources.type_id", "=", (filter as { typeId: string }).typeId))
    .executeTakeFirstOrThrow();
  return row.n;
}

async function assertMedia(db: Db, centreId: string, mediaId: string): Promise<{ width: number; height: number }> {
  const media = await db
    .selectFrom("media_files")
    .select(["width", "height"])
    .where("id", "=", mediaId)
    .where("centre_id", "=", centreId)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!media) throw unprocessable("unknown_media", "the image does not exist or is archived");
  return media;
}

/**
 * Checks a layout against the shared schema, then that it only places live resources of this floor and draws only
 * zones of this floor. Returns the normalised layout to store.
 */
async function validateLayout(db: Db, centreId: string, floorId: string, value: unknown): Promise<FloorLayout> {
  const parsed = floorLayoutSchema.safeParse(value);
  if (!parsed.success) {
    throw unprocessable(
      "invalid_layout",
      "the layout is invalid",
      parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    );
  }
  const layout = parsed.data;
  const resourceIds = layout.items.map((i) => i.resourceId);
  if (resourceIds.length) {
    const found = new Set(
      (
        await db
          .selectFrom("cw_resources")
          .select("id")
          .where("centre_id", "=", centreId)
          .where("floor_id", "=", floorId)
          .where("status", "!=", "archived")
          .where("id", "in", resourceIds)
          .execute()
      ).map((r) => r.id),
    );
    const missing = resourceIds.filter((id) => !found.has(id));
    if (missing.length)
      throw unprocessable("unknown_plan_resource", "the layout places resources that are not live resources of this floor", { resourceIds: missing });
  }
  const zoneIds = [...new Set(layout.areas.map((a) => a.zoneId))];
  if (zoneIds.length) {
    const found = new Set(
      (
        await db
          .selectFrom("cw_zones")
          .select("id")
          .where("centre_id", "=", centreId)
          .where("floor_id", "=", floorId)
          .where("status", "=", "active")
          .where("id", "in", zoneIds)
          .execute()
      ).map((z) => z.id),
    );
    const missing = zoneIds.filter((id) => !found.has(id));
    if (missing.length) throw unprocessable("unknown_plan_zone", "the layout draws zones that are not zones of this floor", { zoneIds: missing });
  }
  return layout;
}

/** Removes a resource from the published layout and the draft of its floor, when it is no longer placed there. */
async function removeFromLayouts(trx: Transaction<Database>, floorId: string, resourceId: string): Promise<void> {
  const floor = await trx.selectFrom("cw_floors").select(["layout", "draft_layout"]).where("id", "=", floorId).forUpdate().executeTakeFirstOrThrow();
  const strip = (value: unknown): FloorLayout | null => {
    const layout = parseLayout(value);
    if (!layout.items.some((i) => i.resourceId === resourceId)) return null;
    return { ...layout, items: layout.items.filter((i) => i.resourceId !== resourceId) };
  };
  const published = strip(floor.layout);
  const draft = floor.draft_layout === null ? null : strip(floor.draft_layout);
  if (!published && !draft) return;
  await trx
    .updateTable("cw_floors")
    .set({ ...(published ? { layout: JSON.stringify(published) } : {}), ...(draft ? { draft_layout: JSON.stringify(draft) } : {}) })
    .where("id", "=", floorId)
    .execute();
}

interface FormatValues {
  nature: CwFormatNature;
  duration_minutes: number | null;
  start_step_minutes: number | null;
  start_time: string | null;
  end_time: string | null;
  min_minutes: number | null;
  max_minutes: number | null;
}

interface FormatInput {
  nature: CwFormatNature;
  durationMinutes?: number | null | undefined;
  startStepMinutes?: number | null | undefined;
  startTime?: string | null | undefined;
  endTime?: string | null | undefined;
  minMinutes?: number | null | undefined;
  maxMinutes?: number | null | undefined;
}

/** The format rules of the database, as explicit errors: each nature has its own fields and ranges. */
function formatValues(input: FormatInput): FormatValues {
  const v = {
    duration: input.durationMinutes ?? null,
    step: input.startStepMinutes ?? null,
    start: input.startTime ?? null,
    end: input.endTime ?? null,
    min: input.minMinutes ?? null,
    max: input.maxMinutes ?? null,
  };
  const allowed: Record<CwFormatNature, (keyof typeof v)[]> = { fixed: ["duration", "step"], named: ["start", "end"], free: ["min", "max", "step"] };
  const extra = (Object.keys(v) as (keyof typeof v)[]).filter((k) => v[k] !== null && !allowed[input.nature].includes(k));
  if (extra.length) throw unprocessable("format_fields_mismatch", `these fields do not apply to a ${input.nature} format`, { fields: extra });
  const validStep = v.step !== null && [15, 30, 60].includes(v.step);
  if (input.nature === "fixed") {
    if (v.duration === null || v.duration < 15 || v.duration > 1440)
      throw unprocessable("format_duration_invalid", "the duration must be between 15 and 1440 minutes");
    if (!validStep) throw unprocessable("format_step_invalid", "start times are spaced 15, 30 or 60 minutes apart");
  } else if (input.nature === "named") {
    if (v.start === null || v.end === null || toClock(v.end) <= toClock(v.start))
      throw unprocessable("format_hours_invalid", "the end time must be after the start time");
  } else {
    if (v.min === null || v.max === null || v.min < 15 || v.min > 1440 || v.max < v.min || v.max > 1440) {
      throw unprocessable("format_range_invalid", "the minimum is between 15 and 1440 minutes and the maximum between the minimum and 1440");
    }
    if (!validStep) throw unprocessable("format_step_invalid", "start times are spaced 15, 30 or 60 minutes apart");
  }
  return {
    nature: input.nature,
    duration_minutes: v.duration,
    start_step_minutes: v.step,
    start_time: v.start,
    end_time: v.end,
    min_minutes: v.min,
    max_minutes: v.max,
  };
}

type EntitlementInput = z.infer<typeof entitlementInput>;

/** Plan rules: monthly billing over a long period, an assigned type of an assigned category, consistent quotas. */
async function validatePlan(
  db: Db,
  centreId: string,
  plan: { period: string; billing: string; assignedTypeId: string | null; entitlements: EntitlementInput[] },
): Promise<void> {
  if (plan.billing === "monthly" && plan.period === "month") throw unprocessable("monthly_billing_period", "monthly billing needs a quarterly or yearly plan");
  if (plan.assignedTypeId) {
    const type = await db
      .selectFrom("cw_resource_types")
      .select(["category", "status"])
      .where("id", "=", plan.assignedTypeId)
      .where("centre_id", "=", centreId)
      .executeTakeFirst();
    if (!type || type.status !== "active" || !isAssigned(type.category)) {
      throw unprocessable("not_assigned_type", "the assigned type must be an active dedicated desk or private office type");
    }
  }
  const typeIds = plan.entitlements.map((e) => e.typeId);
  if (new Set(typeIds).size !== typeIds.length) throw unprocessable("duplicate_entitlement", "each resource type appears once in the entitlements");
  for (const e of plan.entitlements) {
    if ((e.quotaKind === "unlimited") !== (e.quota === null))
      throw unprocessable("invalid_quota", "an unlimited entitlement has no quota, the others need one");
  }
  if (typeIds.length) {
    const types = await db
      .selectFrom("cw_resource_types")
      .select(["id", "category"])
      .where("centre_id", "=", centreId)
      .where("status", "=", "active")
      .where("id", "in", typeIds)
      .execute();
    if (types.length !== typeIds.length || types.some((t) => isAssigned(t.category))) {
      throw unprocessable("entitlement_type_invalid", "entitlements apply to active bookable resource types");
    }
  }
}

async function bookableType(db: Db, centreId: string, typeId: string, code: string): Promise<void> {
  const type = await db
    .selectFrom("cw_resource_types")
    .select(["category", "status"])
    .where("id", "=", typeId)
    .where("centre_id", "=", centreId)
    .executeTakeFirst();
  if (!type || type.status !== "active" || isAssigned(type.category)) throw unprocessable(code, "the resource type must be an active bookable type");
}

const SETTINGS_COLUMNS = [
  "booking_horizon_days",
  "min_notice_minutes",
  "max_active_bookings",
  "approval_mode",
  "free_cancel_hours",
  "late_cancel_fee_bp",
  "no_show_grace_minutes",
  "request_expiry_hours",
  "self_signup",
  "offpeak_from",
  "portal_enabled",
  "updated_at",
] as const;

async function loadSettings(db: Db, centreId: string, lock = false) {
  await db
    .insertInto("cw_settings")
    .values({ centre_id: centreId })
    .onConflict((oc) => oc.column("centre_id").doNothing())
    .execute();
  return db
    .selectFrom("cw_settings")
    .select(SETTINGS_COLUMNS)
    .where("centre_id", "=", centreId)
    .$if(lock, (qb) => qb.forUpdate())
    .executeTakeFirstOrThrow();
}

const presentSettings = (s: Awaited<ReturnType<typeof loadSettings>>) => ({
  bookingHorizonDays: s.booking_horizon_days,
  minNoticeMinutes: s.min_notice_minutes,
  maxActiveBookings: s.max_active_bookings,
  approvalMode: s.approval_mode,
  freeCancelHours: s.free_cancel_hours,
  lateCancelFeeBp: s.late_cancel_fee_bp,
  noShowGraceMinutes: s.no_show_grace_minutes,
  requestExpiryHours: s.request_expiry_hours,
  selfSignup: s.self_signup,
  offpeakFrom: s.offpeak_from === null ? null : toClock(s.offpeak_from),
  portalEnabled: s.portal_enabled,
  updatedAt: s.updated_at,
});

const FLOOR_COLUMNS = [
  "cw_floors.id",
  "cw_floors.name",
  "cw_floors.position",
  "cw_floors.status",
  "cw_floors.plan_media_id as planMediaId",
  "cw_floors.layout_published_at as layoutPublishedAt",
] as const;
const ZONE_COLUMNS = ["id", "floor_id as floorId", "name", "color", "status"] as const;
const ATTRIBUTE_COLUMNS = ["id", "name", "status"] as const;
const TYPE_COLUMNS = [
  "id",
  "name",
  "category",
  "description",
  "photo_media_id as photoMediaId",
  "requires_approval as requiresApproval",
  "max_minutes_per_day as maxMinutesPerDay",
  "buffer_minutes as bufferMinutes",
  "position",
  "public",
  "status",
] as const;
const PACK_COLUMNS = [
  "id",
  "name",
  "type_id as typeId",
  "quota_kind as quotaKind",
  "quota",
  "validity_days as validityDays",
  "price",
  "public",
  "status",
] as const;
const PROMO_COLUMNS = ["id", "code", "kind", "value", "valid_from as validFrom", "valid_to as validTo", "max_uses as maxUses", "profiles", "status"] as const;
const CLOSURE_COLUMNS = ["id", "starts_on as startsOn", "ends_on as endsOn", "label", "open_from as openFrom", "open_to as openTo"] as const;

const presentClosure = (c: { id: string; startsOn: string; endsOn: string; label: string; openFrom: string | null; openTo: string | null }) => ({
  ...c,
  openFrom: c.openFrom === null ? null : toClock(c.openFrom),
  openTo: c.openTo === null ? null : toClock(c.openTo),
});

const presentFormat = (f: {
  id: string;
  typeId: string;
  label: string;
  nature: CwFormatNature;
  durationMinutes: number | null;
  startStepMinutes: number | null;
  startTime: string | null;
  endTime: string | null;
  minMinutes: number | null;
  maxMinutes: number | null;
  weekdays: number[];
  position: number;
  status: "active" | "archived";
}) => ({ ...f, startTime: f.startTime === null ? null : toClock(f.startTime), endTime: f.endTime === null ? null : toClock(f.endTime) });

const FORMAT_COLUMNS = [
  "id",
  "type_id as typeId",
  "label",
  "nature",
  "duration_minutes as durationMinutes",
  "start_step_minutes as startStepMinutes",
  "start_time as startTime",
  "end_time as endTime",
  "min_minutes as minMinutes",
  "max_minutes as maxMinutes",
  "weekdays",
  "position",
  "status",
] as const;

/** Coworking configuration: rules, floors and plans, zones, attributes, resource types, resources, formats, prices, closures, plans, packs and promotion codes (staff). */
export const coworkingConfigRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const read = app.requirePermission("coworking:read");
  const manage = app.requirePermission("coworking:manage");

  const audit = (
    trx: Transaction<Database>,
    actor: SessionUser,
    action: string,
    objectType: string,
    objectId: string,
    extra: { before?: unknown; after?: unknown; reason?: string },
  ) => writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action, objectType, objectId, ...extra });

  /* Rules */

  app.get("/settings", { preHandler: read }, async (request) => presentSettings(await loadSettings(db, request.user!.centreId)));

  app.put("/settings", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const body = settingsBody.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const before = await loadSettings(trx, actor.centreId, true);
      const after = await trx
        .updateTable("cw_settings")
        .set({
          ...(body.bookingHorizonDays === undefined ? {} : { booking_horizon_days: body.bookingHorizonDays }),
          ...(body.minNoticeMinutes === undefined ? {} : { min_notice_minutes: body.minNoticeMinutes }),
          ...(body.maxActiveBookings === undefined ? {} : { max_active_bookings: body.maxActiveBookings }),
          ...(body.approvalMode === undefined ? {} : { approval_mode: body.approvalMode }),
          ...(body.freeCancelHours === undefined ? {} : { free_cancel_hours: body.freeCancelHours }),
          ...(body.lateCancelFeeBp === undefined ? {} : { late_cancel_fee_bp: body.lateCancelFeeBp }),
          ...(body.noShowGraceMinutes === undefined ? {} : { no_show_grace_minutes: body.noShowGraceMinutes }),
          ...(body.requestExpiryHours === undefined ? {} : { request_expiry_hours: body.requestExpiryHours }),
          ...(body.selfSignup === undefined ? {} : { self_signup: body.selfSignup }),
          ...(body.offpeakFrom === undefined ? {} : { offpeak_from: body.offpeakFrom }),
          ...(body.portalEnabled === undefined ? {} : { portal_enabled: body.portalEnabled }),
          updated_at: new Date(),
          updated_by: actor.userId,
        })
        .where("centre_id", "=", actor.centreId)
        .returning(SETTINGS_COLUMNS)
        .executeTakeFirstOrThrow();
      await audit(trx, actor, "cw_settings.updated", "cw_settings", actor.centreId, { before: presentSettings(before), after: presentSettings(after) });
      return presentSettings(after);
    });
  });

  /* Floors and their plan */

  const loadFloor = async (trx: Transaction<Database>, centreId: string, id: string) => {
    const floor = await trx
      .selectFrom("cw_floors")
      .select(["id", "name", "status", "layout", "draft_layout", "plan_media_id"])
      .where("id", "=", id)
      .where("centre_id", "=", centreId)
      .forUpdate()
      .executeTakeFirst();
    if (!floor) throw notFound("floor");
    if (floor.status !== "active") throw conflict("floor_archived", "the floor is archived");
    return floor;
  };

  app.get("/floors", { preHandler: read }, async (request) => {
    const { status } = statusQuery.parse(request.query);
    return db
      .selectFrom("cw_floors")
      .select([
        ...FLOOR_COLUMNS,
        sql<boolean>`cw_floors.draft_layout is not null`.as("hasDraft"),
        (eb) =>
          eb
            .selectFrom("cw_resources")
            .select(sql<number>`count(*)::integer`.as("n"))
            .whereRef("cw_resources.floor_id", "=", "cw_floors.id")
            .where("cw_resources.status", "!=", "archived")
            .as("resourceCount"),
      ])
      .where("cw_floors.centre_id", "=", request.user!.centreId)
      .$if(status !== "all", (qb) => qb.where("cw_floors.status", "=", status as "active" | "archived"))
      .orderBy("cw_floors.position")
      .orderBy("cw_floors.name")
      .execute();
  });

  app.post("/floors", { preHandler: manage }, async (request, reply) => {
    const actor = request.user!;
    const body = floorCreate.parse(request.body);
    const row = await db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto("cw_floors")
        .values({ centre_id: actor.centreId, name: body.name, position: body.position ?? 0 })
        .returning(FLOOR_COLUMNS)
        .executeTakeFirstOrThrow();
      await audit(trx, actor, "cw_floor.created", "cw_floor", created.id, { after: created });
      return created;
    });
    return reply.status(201).send(row);
  });

  app.patch("/floors/:id", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = floorUpdate.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const before = await loadFloor(trx, actor.centreId, id);
      const after = await trx
        .updateTable("cw_floors")
        .set({ ...(body.name === undefined ? {} : { name: body.name }), ...(body.position === undefined ? {} : { position: body.position }) })
        .where("id", "=", id)
        .returning(FLOOR_COLUMNS)
        .executeTakeFirstOrThrow();
      await audit(trx, actor, "cw_floor.updated", "cw_floor", id, { before: { name: before.name }, after });
      return after;
    });
  });

  app.post("/floors/:id/archive", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { reason } = archiveBody.parse(request.body);
    return db.transaction().execute(async (trx) => {
      await loadFloor(trx, actor.centreId, id);
      const live = await trx.selectFrom("cw_resources").select("id").where("floor_id", "=", id).where("status", "!=", "archived").executeTakeFirst();
      if (live) throw conflict("floor_has_resources", "archive or move the resources of this floor first");
      const after = await trx.updateTable("cw_floors").set({ status: "archived" }).where("id", "=", id).returning(FLOOR_COLUMNS).executeTakeFirstOrThrow();
      await audit(trx, actor, "cw_floor.archived", "cw_floor", id, { after: { status: "archived" }, reason });
      return after;
    });
  });

  app.put("/floors/:id/plan", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = planBody.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const before = await loadFloor(trx, actor.centreId, id);
      const media = body.mediaId === null ? null : await assertMedia(trx, actor.centreId, body.mediaId);
      await trx.updateTable("cw_floors").set({ plan_media_id: body.mediaId }).where("id", "=", id).execute();
      await audit(trx, actor, "cw_floor.plan_changed", "cw_floor", id, { before: { planMediaId: before.plan_media_id }, after: { planMediaId: body.mediaId } });
      return { id, planMediaId: body.mediaId, planWidth: media?.width ?? null, planHeight: media?.height ?? null };
    });
  });

  /** Everything the plan editor needs: both layouts, the plan image size, the zones and the live resources of the floor. */
  app.get("/floors/:id", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const { id } = idParam.parse(request.params);
    const floor = await db
      .selectFrom("cw_floors")
      .leftJoin("media_files", "media_files.id", "cw_floors.plan_media_id")
      .leftJoin("users", "users.id", "cw_floors.layout_published_by")
      .select([
        ...FLOOR_COLUMNS,
        "cw_floors.layout",
        "cw_floors.draft_layout as draftLayout",
        "users.full_name as layoutPublishedBy",
        "media_files.width as planWidth",
        "media_files.height as planHeight",
      ])
      .where("cw_floors.id", "=", id)
      .where("cw_floors.centre_id", "=", centreId)
      .executeTakeFirst();
    if (!floor) throw notFound("floor");
    const zones = await db.selectFrom("cw_zones").select(ZONE_COLUMNS).where("floor_id", "=", id).where("status", "=", "active").orderBy("name").execute();
    const resources = await db
      .selectFrom("cw_resources")
      .innerJoin("cw_resource_types", "cw_resource_types.id", "cw_resources.type_id")
      .select([
        "cw_resources.id",
        "cw_resources.code",
        "cw_resources.name",
        "cw_resources.type_id as typeId",
        "cw_resource_types.name as typeName",
        "cw_resource_types.category",
        "cw_resources.zone_id as zoneId",
        "cw_resources.capacity",
        "cw_resources.status",
      ])
      .where("cw_resources.floor_id", "=", id)
      .where("cw_resources.status", "!=", "archived")
      .orderBy("cw_resources.code")
      .execute();
    return {
      ...floor,
      layout: parseLayout(floor.layout),
      draftLayout: floor.draftLayout === null ? null : parseLayout(floor.draftLayout),
      zones,
      resources,
    };
  });

  app.put("/floors/:id/draft-layout", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    return db.transaction().execute(async (trx) => {
      await loadFloor(trx, actor.centreId, id);
      const layout = await validateLayout(trx, actor.centreId, id, request.body);
      await trx
        .updateTable("cw_floors")
        .set({ draft_layout: JSON.stringify(layout) })
        .where("id", "=", id)
        .execute();
      await audit(trx, actor, "cw_floor.draft_saved", "cw_floor", id, {
        after: { items: layout.items.length, labels: layout.labels.length, areas: layout.areas.length },
      });
      return { id, draftLayout: layout };
    });
  });

  app.delete("/floors/:id/draft-layout", { preHandler: manage }, async (request, reply) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    await db.transaction().execute(async (trx) => {
      const floor = await loadFloor(trx, actor.centreId, id);
      if (floor.draft_layout === null) throw conflict("no_draft", "the floor has no draft layout");
      await trx.updateTable("cw_floors").set({ draft_layout: null }).where("id", "=", id).execute();
      await audit(trx, actor, "cw_floor.draft_discarded", "cw_floor", id, {});
    });
    return reply.status(204).send();
  });

  /** The draft becomes what staff and clients see. It is validated again: resources may have changed since it was saved. */
  app.post("/floors/:id/publish", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    return db.transaction().execute(async (trx) => {
      const floor = await loadFloor(trx, actor.centreId, id);
      if (floor.draft_layout === null) throw conflict("no_draft", "the floor has no draft layout");
      const layout = await validateLayout(trx, actor.centreId, id, floor.draft_layout);
      const publishedAt = new Date();
      await trx
        .updateTable("cw_floors")
        .set({ layout: JSON.stringify(layout), draft_layout: null, layout_published_at: publishedAt, layout_published_by: actor.userId })
        .where("id", "=", id)
        .execute();
      await audit(trx, actor, "cw_floor.layout_published", "cw_floor", id, { before: parseLayout(floor.layout), after: layout });
      return { id, layout, layoutPublishedAt: publishedAt };
    });
  });

  /* Zones */

  app.get("/zones", { preHandler: read }, async (request) => {
    const query = zoneQuery.parse(request.query);
    return db
      .selectFrom("cw_zones")
      .select(ZONE_COLUMNS)
      .where("centre_id", "=", request.user!.centreId)
      .$if(query.floorId !== undefined, (qb) => qb.where("floor_id", "=", query.floorId!))
      .$if(query.status !== "all", (qb) => qb.where("status", "=", query.status as "active" | "archived"))
      .orderBy("name")
      .execute();
  });

  app.post("/zones", { preHandler: manage }, async (request, reply) => {
    const actor = request.user!;
    const body = zoneCreate.parse(request.body);
    const row = await db.transaction().execute(async (trx) => {
      const floor = await trx
        .selectFrom("cw_floors")
        .select("id")
        .where("id", "=", body.floorId)
        .where("centre_id", "=", actor.centreId)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (!floor) throw unprocessable("unknown_floor", "the floor does not exist or is archived");
      const created = await trx
        .insertInto("cw_zones")
        .values({ centre_id: actor.centreId, floor_id: body.floorId, name: body.name, ...(body.color === undefined ? {} : { color: body.color }) })
        .returning(ZONE_COLUMNS)
        .executeTakeFirstOrThrow();
      await audit(trx, actor, "cw_zone.created", "cw_zone", created.id, { after: created });
      return created;
    });
    return reply.status(201).send(row);
  });

  app.patch("/zones/:id", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = zoneUpdate.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom("cw_zones")
        .select(ZONE_COLUMNS)
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw notFound("zone");
      const after = await trx
        .updateTable("cw_zones")
        .set({ ...(body.name === undefined ? {} : { name: body.name }), ...(body.color === undefined ? {} : { color: body.color }) })
        .where("id", "=", id)
        .returning(ZONE_COLUMNS)
        .executeTakeFirstOrThrow();
      await audit(trx, actor, "cw_zone.updated", "cw_zone", id, { before, after });
      return after;
    });
  });

  app.post("/zones/:id/archive", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { reason } = archiveBody.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const zone = await trx.selectFrom("cw_zones").select("id").where("id", "=", id).where("centre_id", "=", actor.centreId).forUpdate().executeTakeFirst();
      if (!zone) throw notFound("zone");
      const used = await trx.selectFrom("cw_resources").select("id").where("zone_id", "=", id).where("status", "!=", "archived").executeTakeFirst();
      if (used) throw conflict("zone_in_use", "move the resources of this zone first");
      const after = await trx.updateTable("cw_zones").set({ status: "archived" }).where("id", "=", id).returning(ZONE_COLUMNS).executeTakeFirstOrThrow();
      await audit(trx, actor, "cw_zone.archived", "cw_zone", id, { after: { status: "archived" }, reason });
      return after;
    });
  });

  /* Attributes */

  app.get("/attributes", { preHandler: read }, async (request) => {
    const { status } = statusQuery.parse(request.query);
    return db
      .selectFrom("cw_attributes")
      .select(ATTRIBUTE_COLUMNS)
      .where("centre_id", "=", request.user!.centreId)
      .$if(status !== "all", (qb) => qb.where("status", "=", status as "active" | "archived"))
      .orderBy("name")
      .execute();
  });

  app.post("/attributes", { preHandler: manage }, async (request, reply) => {
    const actor = request.user!;
    const body = attributeBody.parse(request.body);
    const row = await db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto("cw_attributes")
        .values({ centre_id: actor.centreId, name: body.name })
        .returning(ATTRIBUTE_COLUMNS)
        .executeTakeFirstOrThrow();
      await audit(trx, actor, "cw_attribute.created", "cw_attribute", created.id, { after: created });
      return created;
    });
    return reply.status(201).send(row);
  });

  app.patch("/attributes/:id", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = attributeBody.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom("cw_attributes")
        .select(ATTRIBUTE_COLUMNS)
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw notFound("attribute");
      const after = await trx.updateTable("cw_attributes").set({ name: body.name }).where("id", "=", id).returning(ATTRIBUTE_COLUMNS).executeTakeFirstOrThrow();
      await audit(trx, actor, "cw_attribute.updated", "cw_attribute", id, { before, after });
      return after;
    });
  });

  app.post("/attributes/:id/archive", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { reason } = archiveBody.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const after = await trx
        .updateTable("cw_attributes")
        .set({ status: "archived" })
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .returning(ATTRIBUTE_COLUMNS)
        .executeTakeFirst();
      if (!after) throw notFound("attribute");
      await audit(trx, actor, "cw_attribute.archived", "cw_attribute", id, { after: { status: "archived" }, reason });
      return after;
    });
  });

  /* Resource types */

  app.get("/resource-types", { preHandler: read }, async (request) => {
    const { status } = statusQuery.parse(request.query);
    return db
      .selectFrom("cw_resource_types")
      .select([
        ...TYPE_COLUMNS,
        (eb) =>
          eb
            .selectFrom("cw_resources")
            .select(sql<number>`count(*)::integer`.as("n"))
            .whereRef("cw_resources.type_id", "=", "cw_resource_types.id")
            .where("cw_resources.status", "!=", "archived")
            .as("resourceCount"),
      ])
      .where("centre_id", "=", request.user!.centreId)
      .$if(status !== "all", (qb) => qb.where("status", "=", status as "active" | "archived"))
      .orderBy("position")
      .orderBy("name")
      .execute();
  });

  app.post("/resource-types", { preHandler: manage }, async (request, reply) => {
    const actor = request.user!;
    const body = typeCreate.parse(request.body);
    const row = await db.transaction().execute(async (trx) => {
      if (body.photoMediaId) await assertMedia(trx, actor.centreId, body.photoMediaId);
      const created = await trx
        .insertInto("cw_resource_types")
        .values({
          centre_id: actor.centreId,
          name: body.name,
          category: body.category,
          description: body.description ?? null,
          photo_media_id: body.photoMediaId ?? null,
          max_minutes_per_day: body.maxMinutesPerDay ?? null,
          ...(body.requiresApproval === undefined ? {} : { requires_approval: body.requiresApproval }),
          ...(body.bufferMinutes === undefined ? {} : { buffer_minutes: body.bufferMinutes }),
          ...(body.position === undefined ? {} : { position: body.position }),
          ...(body.public === undefined ? {} : { public: body.public }),
        })
        .returning(TYPE_COLUMNS)
        .executeTakeFirstOrThrow();
      await audit(trx, actor, "cw_resource_type.created", "cw_resource_type", created.id, { after: created });
      return created;
    });
    return reply.status(201).send(row);
  });

  app.patch("/resource-types/:id", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = typeUpdate.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom("cw_resource_types")
        .select(TYPE_COLUMNS)
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw notFound("resource type");
      if (body.category !== undefined && body.category !== before.category) {
        // The category decides whether a type is booked or assigned: once anything relies on it, it stays.
        const [resource, plan, entitlement, pack, format] = await Promise.all([
          trx.selectFrom("cw_resources").select("id").where("type_id", "=", id).executeTakeFirst(),
          trx.selectFrom("cw_plans").select("id").where("assigned_type_id", "=", id).executeTakeFirst(),
          trx.selectFrom("cw_plan_entitlements").select("plan_id").where("type_id", "=", id).executeTakeFirst(),
          trx.selectFrom("cw_pack_products").select("id").where("type_id", "=", id).executeTakeFirst(),
          trx.selectFrom("cw_booking_formats").select("id").where("type_id", "=", id).executeTakeFirst(),
        ]);
        if (resource || plan || entitlement || pack || format)
          throw conflict("category_locked", "the category cannot change once resources, formats, plans or packs use this type");
      }
      if (body.photoMediaId) await assertMedia(trx, actor.centreId, body.photoMediaId);
      const after = await trx
        .updateTable("cw_resource_types")
        .set({
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.category === undefined ? {} : { category: body.category }),
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.photoMediaId === undefined ? {} : { photo_media_id: body.photoMediaId }),
          ...(body.requiresApproval === undefined ? {} : { requires_approval: body.requiresApproval }),
          ...(body.maxMinutesPerDay === undefined ? {} : { max_minutes_per_day: body.maxMinutesPerDay }),
          ...(body.bufferMinutes === undefined ? {} : { buffer_minutes: body.bufferMinutes }),
          ...(body.position === undefined ? {} : { position: body.position }),
          ...(body.public === undefined ? {} : { public: body.public }),
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .returning(TYPE_COLUMNS)
        .executeTakeFirstOrThrow();
      await audit(trx, actor, "cw_resource_type.updated", "cw_resource_type", id, { before, after });
      return after;
    });
  });

  app.post("/resource-types/:id/archive", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { reason } = archiveBody.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const type = await trx
        .selectFrom("cw_resource_types")
        .select("id")
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!type) throw notFound("resource type");
      const count = await futureBookingCount(trx, { typeId: id });
      if (count > 0) throw new HttpError(409, "resource_has_bookings", "resources of this type have upcoming bookings", { count });
      const after = await trx
        .updateTable("cw_resource_types")
        .set({ status: "archived", updated_at: new Date() })
        .where("id", "=", id)
        .returning(TYPE_COLUMNS)
        .executeTakeFirstOrThrow();
      await audit(trx, actor, "cw_resource_type.archived", "cw_resource_type", id, { after: { status: "archived" }, reason });
      return { ...after, futureBookings: 0 };
    });
  });

  /* Resources */

  const resourceQueryBase = (centreId: string) =>
    db
      .selectFrom("cw_resources")
      .innerJoin("cw_resource_types", "cw_resource_types.id", "cw_resources.type_id")
      .innerJoin("cw_floors", "cw_floors.id", "cw_resources.floor_id")
      .leftJoin("cw_zones", "cw_zones.id", "cw_resources.zone_id")
      .leftJoin("rooms", "rooms.id", "cw_resources.room_id")
      .select([
        "cw_resources.id",
        "cw_resources.code",
        "cw_resources.name",
        "cw_resources.type_id as typeId",
        "cw_resource_types.name as typeName",
        "cw_resource_types.category",
        "cw_resources.floor_id as floorId",
        "cw_floors.name as floorName",
        "cw_resources.zone_id as zoneId",
        "cw_zones.name as zoneName",
        "cw_resources.capacity",
        "cw_resources.room_id as roomId",
        "rooms.name as roomName",
        "cw_resources.status",
        "cw_resources.out_of_service_reason as outOfServiceReason",
        sql<
          string[]
        >`coalesce((select array_agg(ra.attribute_id order by ra.attribute_id) from cw_resource_attributes ra where ra.resource_id = cw_resources.id), '{}')`.as(
          "attributeIds",
        ),
      ])
      .where("cw_resources.centre_id", "=", centreId);

  const loadResource = async (centreId: string, id: string) => {
    const row = await resourceQueryBase(centreId).where("cw_resources.id", "=", id).executeTakeFirst();
    if (!row) throw notFound("resource");
    return row;
  };

  /** Checks the references of a resource; each one is checked only when it is set or changed. */
  const assertResourceRefs = async (
    trx: Transaction<Database>,
    centreId: string,
    resourceId: string | null,
    refs: { typeId?: string; floorId?: string; zone?: { zoneId: string; floorId: string }; attributeIds?: string[]; roomId?: string },
  ) => {
    if (refs.typeId) {
      const type = await trx
        .selectFrom("cw_resource_types")
        .select("id")
        .where("id", "=", refs.typeId)
        .where("centre_id", "=", centreId)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (!type) throw unprocessable("unknown_type", "the resource type does not exist or is archived");
    }
    if (refs.floorId) {
      const floor = await trx
        .selectFrom("cw_floors")
        .select("id")
        .where("id", "=", refs.floorId)
        .where("centre_id", "=", centreId)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (!floor) throw unprocessable("unknown_floor", "the floor does not exist or is archived");
    }
    if (refs.zone) {
      const zone = await trx
        .selectFrom("cw_zones")
        .select("id")
        .where("id", "=", refs.zone.zoneId)
        .where("floor_id", "=", refs.zone.floorId)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (!zone) throw unprocessable("unknown_zone", "the zone is not an active zone of this floor");
    }
    if (refs.attributeIds?.length) {
      const unique = [...new Set(refs.attributeIds)];
      const found = await trx
        .selectFrom("cw_attributes")
        .select("id")
        .where("centre_id", "=", centreId)
        .where("status", "=", "active")
        .where("id", "in", unique)
        .execute();
      if (found.length !== unique.length) throw unprocessable("unknown_attribute", "an attribute does not exist or is archived");
    }
    if (refs.roomId) {
      const room = await trx
        .selectFrom("rooms")
        .select("id")
        .where("id", "=", refs.roomId)
        .where("centre_id", "=", centreId)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (!room) throw unprocessable("unknown_room", "the room does not exist or is archived");
      const linked = await trx
        .selectFrom("cw_resources")
        .select("id")
        .where("room_id", "=", refs.roomId)
        .where("status", "!=", "archived")
        .$if(resourceId !== null, (qb) => qb.where("id", "!=", resourceId!))
        .executeTakeFirst();
      if (linked) throw conflict("room_linked", "this room is already linked to another resource");
    }
  };

  const assertCodeFree = async (trx: Transaction<Database>, centreId: string, code: string, resourceId: string | null) => {
    const taken = await trx
      .selectFrom("cw_resources")
      .select("id")
      .where("centre_id", "=", centreId)
      .where(sql<string>`lower(code)`, "=", code.toLowerCase())
      .$if(resourceId !== null, (qb) => qb.where("id", "!=", resourceId!))
      .executeTakeFirst();
    if (taken) throw conflict("code_taken", "another resource already has this code");
  };

  const replaceAttributes = async (trx: Transaction<Database>, resourceId: string, attributeIds: string[]) => {
    await trx.deleteFrom("cw_resource_attributes").where("resource_id", "=", resourceId).execute();
    const unique = [...new Set(attributeIds)];
    if (unique.length) {
      await trx
        .insertInto("cw_resource_attributes")
        .values(unique.map((attributeId) => ({ resource_id: resourceId, attribute_id: attributeId })))
        .execute();
    }
  };

  /** A resource assigned to a subscription that has not ended cannot change type or be archived. */
  const assignedSubscription = async (trx: Transaction<Database>, centreId: string, resourceId: string) => {
    return trx
      .selectFrom("cw_subscriptions")
      .innerJoin("centres", "centres.id", "cw_subscriptions.centre_id")
      .select("cw_subscriptions.id")
      .where("cw_subscriptions.centre_id", "=", centreId)
      .where("cw_subscriptions.assigned_resource_id", "=", resourceId)
      .where("cw_subscriptions.status", "=", "active")
      .where(sql<boolean>`cw_subscriptions.ends_on >= (now() at time zone centres.timezone)::date`)
      .executeTakeFirst();
  };

  app.get("/resources", { preHandler: read }, async (request) => {
    const query = resourceQuery.parse(request.query);
    return resourceQueryBase(request.user!.centreId)
      .$if(query.floorId !== undefined, (qb) => qb.where("cw_resources.floor_id", "=", query.floorId!))
      .$if(query.typeId !== undefined, (qb) => qb.where("cw_resources.type_id", "=", query.typeId!))
      .$if(query.zoneId !== undefined, (qb) => qb.where("cw_resources.zone_id", "=", query.zoneId!))
      .$if(query.status === "current", (qb) => qb.where("cw_resources.status", "!=", "archived"))
      .$if(query.status !== "current" && query.status !== "all", (qb) =>
        qb.where("cw_resources.status", "=", query.status as "active" | "out_of_service" | "archived"),
      )
      .orderBy("cw_resources.code")
      .execute();
  });

  app.get("/resources/:id", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const { id } = idParam.parse(request.params);
    const resource = await loadResource(centreId, id);
    return { ...resource, futureBookings: await futureBookingCount(db, { resourceId: id }) };
  });

  app.post("/resources", { preHandler: manage }, async (request, reply) => {
    const actor = request.user!;
    const body = resourceCreate.parse(request.body);
    const id = await db.transaction().execute(async (trx) => {
      await assertResourceRefs(trx, actor.centreId, null, {
        typeId: body.typeId,
        floorId: body.floorId,
        ...(body.zoneId ? { zone: { zoneId: body.zoneId, floorId: body.floorId } } : {}),
        ...(body.attributeIds ? { attributeIds: body.attributeIds } : {}),
        ...(body.roomId ? { roomId: body.roomId } : {}),
      });
      await assertCodeFree(trx, actor.centreId, body.code, null);
      const created = await trx
        .insertInto("cw_resources")
        .values({
          centre_id: actor.centreId,
          type_id: body.typeId,
          floor_id: body.floorId,
          zone_id: body.zoneId ?? null,
          code: body.code,
          name: body.name ?? null,
          room_id: body.roomId ?? null,
          out_of_service_reason: null,
          ...(body.capacity === undefined ? {} : { capacity: body.capacity }),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await replaceAttributes(trx, created.id, body.attributeIds ?? []);
      await audit(trx, actor, "cw_resource.created", "cw_resource", created.id, { after: body });
      return created.id;
    });
    return reply.status(201).send(await loadResource(actor.centreId, id));
  });

  app.patch("/resources/:id", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = resourceUpdate.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom("cw_resources")
        .select(["id", "code", "type_id", "floor_id", "zone_id", "room_id", "status", "name", "capacity"])
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw notFound("resource");
      if (before.status === "archived") throw conflict("resource_archived", "the resource is archived");
      const floorId = body.floorId ?? before.floor_id;
      const floorChanged = floorId !== before.floor_id;
      if (floorChanged) {
        const oldFloor = await trx.selectFrom("cw_floors").select("layout").where("id", "=", before.floor_id).executeTakeFirstOrThrow();
        if (parseLayout(oldFloor.layout).items.some((i) => i.resourceId === id)) {
          throw conflict("resource_on_plan", "remove the resource from its floor plan and publish it before moving it to another floor");
        }
      }
      const typeChanged = body.typeId !== undefined && body.typeId !== before.type_id;
      if (typeChanged) {
        const count = await futureBookingCount(trx, { resourceId: id });
        if (count > 0) throw new HttpError(409, "resource_has_bookings", "the resource has upcoming bookings", { count });
        if (await assignedSubscription(trx, actor.centreId, id)) throw conflict("resource_assigned", "the resource is assigned to a running subscription");
      }
      // A zone belongs to one floor: moving the resource drops a zone of the old floor unless a new one is given.
      const zoneId = body.zoneId !== undefined ? body.zoneId : floorChanged ? null : before.zone_id;
      await assertResourceRefs(trx, actor.centreId, id, {
        ...(typeChanged ? { typeId: body.typeId! } : {}),
        ...(floorChanged ? { floorId } : {}),
        ...(zoneId && (floorChanged || body.zoneId !== undefined) ? { zone: { zoneId, floorId } } : {}),
        ...(body.attributeIds ? { attributeIds: body.attributeIds } : {}),
        ...(body.roomId && body.roomId !== before.room_id ? { roomId: body.roomId } : {}),
      });
      if (body.code !== undefined && body.code.toLowerCase() !== before.code.toLowerCase()) await assertCodeFree(trx, actor.centreId, body.code, id);
      if (floorChanged) await removeFromLayouts(trx, before.floor_id, id);
      await trx
        .updateTable("cw_resources")
        .set({
          ...(body.code === undefined ? {} : { code: body.code }),
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(typeChanged ? { type_id: body.typeId! } : {}),
          ...(floorChanged ? { floor_id: floorId } : {}),
          zone_id: zoneId,
          ...(body.capacity === undefined ? {} : { capacity: body.capacity }),
          ...(body.roomId === undefined ? {} : { room_id: body.roomId }),
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .execute();
      if (body.attributeIds) await replaceAttributes(trx, id, body.attributeIds);
      await audit(trx, actor, "cw_resource.updated", "cw_resource", id, { before, after: body });
    });
    return loadResource(actor.centreId, id);
  });

  /** Out of service keeps the bookings (the staff moves or cancels them) and reports how many are affected. */
  app.post("/resources/:id/status", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = resourceStatusBody.parse(request.body);
    const futureBookings = await db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom("cw_resources")
        .select(["status", "out_of_service_reason"])
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw notFound("resource");
      if (before.status === "archived") throw conflict("resource_archived", "the resource is archived");
      await trx
        .updateTable("cw_resources")
        .set({ status: body.status, out_of_service_reason: body.reason ?? null, updated_at: new Date() })
        .where("id", "=", id)
        .execute();
      const count = await futureBookingCount(trx, { resourceId: id });
      await audit(trx, actor, body.status === "active" ? "cw_resource.back_in_service" : "cw_resource.out_of_service", "cw_resource", id, {
        before: { status: before.status, reason: before.out_of_service_reason },
        after: { status: body.status, futureBookings: count },
        ...(body.reason ? { reason: body.reason } : {}),
      });
      return count;
    });
    return { ...(await loadResource(actor.centreId, id)), futureBookings };
  });

  app.post("/resources/:id/archive", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { reason } = archiveBody.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const resource = await trx
        .selectFrom("cw_resources")
        .select(["status", "floor_id"])
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!resource) throw notFound("resource");
      if (resource.status === "archived") throw conflict("resource_archived", "the resource is archived");
      const count = await futureBookingCount(trx, { resourceId: id });
      if (count > 0) throw new HttpError(409, "resource_has_bookings", "the resource has upcoming bookings", { count });
      if (await assignedSubscription(trx, actor.centreId, id)) throw conflict("resource_assigned", "the resource is assigned to a running subscription");
      await removeFromLayouts(trx, resource.floor_id, id);
      await trx.updateTable("cw_resources").set({ status: "archived", out_of_service_reason: null, updated_at: new Date() }).where("id", "=", id).execute();
      await audit(trx, actor, "cw_resource.archived", "cw_resource", id, { before: { status: resource.status }, after: { status: "archived" }, reason });
    });
    return { ...(await loadResource(actor.centreId, id)), futureBookings: 0 };
  });

  /* Booking formats and prices */

  const formatsWithPrices = async (centreId: string, filter: { id?: string; typeId?: string; status?: "active" | "archived" | "all" }) => {
    const formats = await db
      .selectFrom("cw_booking_formats")
      .select(FORMAT_COLUMNS)
      .where("centre_id", "=", centreId)
      .$if(filter.id !== undefined, (qb) => qb.where("id", "=", filter.id!))
      .$if(filter.typeId !== undefined, (qb) => qb.where("type_id", "=", filter.typeId!))
      .$if(filter.status !== undefined && filter.status !== "all", (qb) => qb.where("status", "=", filter.status as "active" | "archived"))
      .orderBy("position")
      .orderBy("label")
      .execute();
    const prices = formats.length
      ? await db
          .selectFrom("cw_prices")
          .select(["format_id as formatId", "profile", "amount", "offpeak_amount as offpeakAmount"])
          .where(
            "format_id",
            "in",
            formats.map((f) => f.id),
          )
          .orderBy("profile", "desc")
          .execute()
      : [];
    return formats.map((f) => ({
      ...presentFormat(f),
      prices: prices.filter((p) => p.formatId === f.id).map(({ profile, amount, offpeakAmount }) => ({ profile, amount, offpeakAmount })),
    }));
  };

  const loadFormat = async (centreId: string, id: string) => {
    const [format] = await formatsWithPrices(centreId, { id });
    if (!format) throw notFound("format");
    return format;
  };

  app.get("/formats", { preHandler: read }, async (request) => {
    const query = formatQuery.parse(request.query);
    return formatsWithPrices(request.user!.centreId, { status: query.status, ...(query.typeId ? { typeId: query.typeId } : {}) });
  });

  app.post("/formats", { preHandler: manage }, async (request, reply) => {
    const actor = request.user!;
    const body = formatCreate.parse(request.body);
    const values = formatValues(body);
    const id = await db.transaction().execute(async (trx) => {
      await bookableType(trx, actor.centreId, body.typeId, "type_not_bookable");
      const created = await trx
        .insertInto("cw_booking_formats")
        .values({
          centre_id: actor.centreId,
          type_id: body.typeId,
          label: body.label,
          ...values,
          ...(body.weekdays === undefined ? {} : { weekdays: [...new Set(body.weekdays)].sort() }),
          ...(body.position === undefined ? {} : { position: body.position }),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await audit(trx, actor, "cw_format.created", "cw_format", created.id, { after: body });
      return created.id;
    });
    return reply.status(201).send(await loadFormat(actor.centreId, id));
  });

  app.patch("/formats/:id", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = formatUpdate.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom("cw_booking_formats")
        .select(FORMAT_COLUMNS)
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw notFound("format");
      if (before.status !== "active") throw conflict("format_archived", "the format is archived");
      // A change of nature replaces every nature field; otherwise the given fields override the stored ones.
      const base = body.nature === undefined || body.nature === before.nature ? before : {};
      const values = formatValues({ ...base, ...body, nature: body.nature ?? before.nature });
      await trx
        .updateTable("cw_booking_formats")
        .set({
          ...values,
          ...(body.label === undefined ? {} : { label: body.label }),
          ...(body.weekdays === undefined ? {} : { weekdays: [...new Set(body.weekdays)].sort() }),
          ...(body.position === undefined ? {} : { position: body.position }),
        })
        .where("id", "=", id)
        .execute();
      await audit(trx, actor, "cw_format.updated", "cw_format", id, { before: presentFormat(before), after: body });
    });
    return loadFormat(actor.centreId, id);
  });

  app.post("/formats/:id/archive", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { reason } = archiveBody.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const archived = await trx
        .updateTable("cw_booking_formats")
        .set({ status: "archived" })
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .returning("id")
        .executeTakeFirst();
      if (!archived) throw notFound("format");
      await audit(trx, actor, "cw_format.archived", "cw_format", id, { after: { status: "archived" }, reason });
    });
    return loadFormat(actor.centreId, id);
  });

  app.put("/formats/:id/prices", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = pricesBody.parse(request.body);
    if (new Set(body.prices.map((p) => p.profile)).size !== body.prices.length) throw unprocessable("duplicate_profile", "each profile has one price");
    await db.transaction().execute(async (trx) => {
      const format = await trx
        .selectFrom("cw_booking_formats")
        .select("id")
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!format) throw notFound("format");
      const before = await trx.selectFrom("cw_prices").select(["profile", "amount", "offpeak_amount as offpeakAmount"]).where("format_id", "=", id).execute();
      await trx.deleteFrom("cw_prices").where("format_id", "=", id).execute();
      if (body.prices.length) {
        await trx
          .insertInto("cw_prices")
          .values(body.prices.map((p) => ({ format_id: id, profile: p.profile, amount: p.amount, offpeak_amount: p.offpeakAmount })))
          .execute();
      }
      await audit(trx, actor, "cw_format.prices_updated", "cw_format", id, { before, after: body.prices });
    });
    return loadFormat(actor.centreId, id);
  });

  /* Closures and reduced hours */

  app.get("/closures", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const query = closureQuery.parse(request.query);
    const from = query.from ?? (await centreClock(db, centreId)).today;
    const rows = await db
      .selectFrom("cw_closures")
      .select(CLOSURE_COLUMNS)
      .where("centre_id", "=", centreId)
      .where("ends_on", ">=", from)
      .orderBy("starts_on")
      .execute();
    return rows.map(presentClosure);
  });

  app.post("/closures", { preHandler: manage }, async (request, reply) => {
    const actor = request.user!;
    const body = closureBody.parse(request.body);
    if (body.endsOn < body.startsOn) throw unprocessable("invalid_range", "the end date cannot be before the start date");
    const openFrom = body.openFrom ?? null;
    const openTo = body.openTo ?? null;
    if ((openFrom === null) !== (openTo === null) || (openFrom !== null && openTo !== null && openTo <= openFrom)) {
      throw unprocessable("closure_hours_invalid", "give no hours for a closed day, or an opening time before a closing time");
    }
    const row = await db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto("cw_closures")
        .values({
          centre_id: actor.centreId,
          starts_on: body.startsOn,
          ends_on: body.endsOn,
          label: body.label,
          open_from: openFrom,
          open_to: openTo,
          created_by: actor.userId,
        })
        .returning(CLOSURE_COLUMNS)
        .executeTakeFirstOrThrow();
      await audit(trx, actor, "cw_closure.created", "cw_closure", created.id, { after: body });
      return presentClosure(created);
    });
    return reply.status(201).send(row);
  });

  app.delete("/closures/:id", { preHandler: manage }, async (request, reply) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    await db.transaction().execute(async (trx) => {
      const deleted = await trx
        .deleteFrom("cw_closures")
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .returning(CLOSURE_COLUMNS)
        .executeTakeFirst();
      if (!deleted) throw notFound("closure");
      await audit(trx, actor, "cw_closure.deleted", "cw_closure", id, { before: presentClosure(deleted) });
    });
    return reply.status(204).send();
  });

  /* Subscription plans */

  const plansWithEntitlements = async (centreId: string, filter: { id?: string; status?: "active" | "archived" | "all" }) => {
    const plans = await db
      .selectFrom("cw_plans")
      .select([
        "id",
        "name",
        "description",
        "period",
        "price",
        "billing",
        "includes_domiciliation as includesDomiciliation",
        "assigned_type_id as assignedTypeId",
        "notice_days as noticeDays",
        "public",
        "position",
        "status",
        (eb) =>
          eb
            .selectFrom("cw_subscriptions")
            .select(sql<number>`count(*)::integer`.as("n"))
            .whereRef("cw_subscriptions.plan_id", "=", "cw_plans.id")
            .where("cw_subscriptions.status", "=", "active")
            .as("subscriptionCount"),
      ])
      .where("centre_id", "=", centreId)
      .$if(filter.id !== undefined, (qb) => qb.where("id", "=", filter.id!))
      .$if(filter.status !== undefined && filter.status !== "all", (qb) => qb.where("status", "=", filter.status as "active" | "archived"))
      .orderBy("position")
      .orderBy("name")
      .execute();
    const entitlements = plans.length
      ? await db
          .selectFrom("cw_plan_entitlements")
          .innerJoin("cw_resource_types", "cw_resource_types.id", "cw_plan_entitlements.type_id")
          .select([
            "cw_plan_entitlements.plan_id as planId",
            "cw_plan_entitlements.type_id as typeId",
            "cw_resource_types.name as typeName",
            "cw_plan_entitlements.quota_kind as quotaKind",
            "cw_plan_entitlements.quota",
          ])
          .where(
            "cw_plan_entitlements.plan_id",
            "in",
            plans.map((p) => p.id),
          )
          .orderBy("cw_resource_types.position")
          .orderBy("cw_resource_types.name")
          .execute()
      : [];
    return plans.map((p) => ({ ...p, entitlements: entitlements.filter((e) => e.planId === p.id).map(({ planId: _planId, ...e }) => e) }));
  };

  const loadPlan = async (centreId: string, id: string) => {
    const [plan] = await plansWithEntitlements(centreId, { id });
    if (!plan) throw notFound("plan");
    return plan;
  };

  const replaceEntitlements = async (trx: Transaction<Database>, planId: string, entitlements: EntitlementInput[]) => {
    await trx.deleteFrom("cw_plan_entitlements").where("plan_id", "=", planId).execute();
    if (entitlements.length) {
      await trx
        .insertInto("cw_plan_entitlements")
        .values(entitlements.map((e) => ({ plan_id: planId, type_id: e.typeId, quota_kind: e.quotaKind, quota: e.quota })))
        .execute();
    }
  };

  app.get("/plans", { preHandler: read }, async (request) => {
    const { status } = statusQuery.parse(request.query);
    return plansWithEntitlements(request.user!.centreId, { status });
  });

  app.post("/plans", { preHandler: manage }, async (request, reply) => {
    const actor = request.user!;
    const body = planCreate.parse(request.body);
    const entitlements = body.entitlements ?? [];
    const id = await db.transaction().execute(async (trx) => {
      await validatePlan(trx, actor.centreId, { period: body.period, billing: body.billing, assignedTypeId: body.assignedTypeId ?? null, entitlements });
      const created = await trx
        .insertInto("cw_plans")
        .values({
          centre_id: actor.centreId,
          name: body.name,
          description: body.description ?? null,
          period: body.period,
          price: body.price,
          billing: body.billing,
          assigned_type_id: body.assignedTypeId ?? null,
          ...(body.includesDomiciliation === undefined ? {} : { includes_domiciliation: body.includesDomiciliation }),
          ...(body.noticeDays === undefined ? {} : { notice_days: body.noticeDays }),
          ...(body.public === undefined ? {} : { public: body.public }),
          ...(body.position === undefined ? {} : { position: body.position }),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await replaceEntitlements(trx, created.id, entitlements);
      await audit(trx, actor, "cw_plan.created", "cw_plan", created.id, { after: body });
      return created.id;
    });
    return reply.status(201).send(await loadPlan(actor.centreId, id));
  });

  /** Plan changes apply to new subscriptions and renewals; subscriptions already sold keep their snapshot. */
  app.patch("/plans/:id", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = planUpdate.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom("cw_plans")
        .select(["id", "name", "period", "price", "billing", "assigned_type_id", "status"])
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw notFound("plan");
      if (before.status !== "active") throw conflict("plan_archived", "the plan is archived");
      const currentEntitlements = await trx
        .selectFrom("cw_plan_entitlements")
        .select(["type_id as typeId", "quota_kind as quotaKind", "quota"])
        .where("plan_id", "=", id)
        .execute();
      await validatePlan(trx, actor.centreId, {
        period: body.period ?? before.period,
        billing: body.billing ?? before.billing,
        assignedTypeId: body.assignedTypeId === undefined ? before.assigned_type_id : body.assignedTypeId,
        entitlements: body.entitlements ?? currentEntitlements,
      });
      await trx
        .updateTable("cw_plans")
        .set({
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.period === undefined ? {} : { period: body.period }),
          ...(body.price === undefined ? {} : { price: body.price }),
          ...(body.billing === undefined ? {} : { billing: body.billing }),
          ...(body.includesDomiciliation === undefined ? {} : { includes_domiciliation: body.includesDomiciliation }),
          ...(body.assignedTypeId === undefined ? {} : { assigned_type_id: body.assignedTypeId }),
          ...(body.noticeDays === undefined ? {} : { notice_days: body.noticeDays }),
          ...(body.public === undefined ? {} : { public: body.public }),
          ...(body.position === undefined ? {} : { position: body.position }),
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .execute();
      if (body.entitlements) await replaceEntitlements(trx, id, body.entitlements);
      await audit(trx, actor, "cw_plan.updated", "cw_plan", id, { before: { ...before, entitlements: currentEntitlements }, after: body });
    });
    return loadPlan(actor.centreId, id);
  });

  app.post("/plans/:id/archive", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { reason } = archiveBody.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const archived = await trx
        .updateTable("cw_plans")
        .set({ status: "archived", updated_at: new Date() })
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .returning("id")
        .executeTakeFirst();
      if (!archived) throw notFound("plan");
      await audit(trx, actor, "cw_plan.archived", "cw_plan", id, { after: { status: "archived" }, reason });
    });
    return loadPlan(actor.centreId, id);
  });

  /* Credit pack products */

  app.get("/pack-products", { preHandler: read }, async (request) => {
    const { status } = statusQuery.parse(request.query);
    return db
      .selectFrom("cw_pack_products")
      .select(PACK_COLUMNS)
      .where("centre_id", "=", request.user!.centreId)
      .$if(status !== "all", (qb) => qb.where("status", "=", status as "active" | "archived"))
      .orderBy("name")
      .execute();
  });

  app.post("/pack-products", { preHandler: manage }, async (request, reply) => {
    const actor = request.user!;
    const body = packCreate.parse(request.body);
    const row = await db.transaction().execute(async (trx) => {
      await bookableType(trx, actor.centreId, body.typeId, "pack_type_invalid");
      const created = await trx
        .insertInto("cw_pack_products")
        .values({
          centre_id: actor.centreId,
          name: body.name,
          type_id: body.typeId,
          quota_kind: body.quotaKind,
          quota: body.quota,
          validity_days: body.validityDays,
          price: body.price,
          ...(body.public === undefined ? {} : { public: body.public }),
        })
        .returning(PACK_COLUMNS)
        .executeTakeFirstOrThrow();
      await audit(trx, actor, "cw_pack_product.created", "cw_pack_product", created.id, { after: created });
      return created;
    });
    return reply.status(201).send(row);
  });

  /** Changes apply to packs sold afterwards; packs already sold keep their snapshot. */
  app.patch("/pack-products/:id", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = packUpdate.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom("cw_pack_products")
        .select(PACK_COLUMNS)
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw notFound("pack product");
      if (before.status !== "active") throw conflict("pack_product_archived", "the pack product is archived");
      if (body.typeId !== undefined && body.typeId !== before.typeId) await bookableType(trx, actor.centreId, body.typeId, "pack_type_invalid");
      const after = await trx
        .updateTable("cw_pack_products")
        .set({
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.typeId === undefined ? {} : { type_id: body.typeId }),
          ...(body.quotaKind === undefined ? {} : { quota_kind: body.quotaKind }),
          ...(body.quota === undefined ? {} : { quota: body.quota }),
          ...(body.validityDays === undefined ? {} : { validity_days: body.validityDays }),
          ...(body.price === undefined ? {} : { price: body.price }),
          ...(body.public === undefined ? {} : { public: body.public }),
        })
        .where("id", "=", id)
        .returning(PACK_COLUMNS)
        .executeTakeFirstOrThrow();
      await audit(trx, actor, "cw_pack_product.updated", "cw_pack_product", id, { before, after });
      return after;
    });
  });

  app.post("/pack-products/:id/archive", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { reason } = archiveBody.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const after = await trx
        .updateTable("cw_pack_products")
        .set({ status: "archived" })
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .returning(PACK_COLUMNS)
        .executeTakeFirst();
      if (!after) throw notFound("pack product");
      await audit(trx, actor, "cw_pack_product.archived", "cw_pack_product", id, { after: { status: "archived" }, reason });
      return after;
    });
  });

  /* Promotion codes */

  const promoUses = sql<number>`(select count(*)::integer from cw_bookings b
    where b.promo_code_id = cw_promo_codes.id and b.status not in ('refused', 'expired', 'cancelled'))`.as("uses");

  const loadPromo = async (centreId: string, id: string) => {
    const row = await db
      .selectFrom("cw_promo_codes")
      .select([...PROMO_COLUMNS, promoUses])
      .where("id", "=", id)
      .where("centre_id", "=", centreId)
      .executeTakeFirst();
    if (!row) throw notFound("promotion code");
    return row;
  };

  const validatePromo = (promo: { code: string; kind: "percent" | "amount"; value: number; validFrom: string; validTo: string }) => {
    if (!/^[A-Z0-9-]{3,30}$/.test(promo.code)) throw unprocessable("invalid_promo_code", "a code has 3 to 30 letters, digits or hyphens");
    if (promo.kind === "percent" && promo.value > 10_000) throw unprocessable("invalid_percent", "a percentage cannot exceed 100 %");
    if (promo.validTo < promo.validFrom) throw unprocessable("invalid_range", "the end date cannot be before the start date");
  };

  const assertPromoCodeFree = async (trx: Transaction<Database>, centreId: string, code: string, promoId: string | null) => {
    const taken = await trx
      .selectFrom("cw_promo_codes")
      .select("id")
      .where("centre_id", "=", centreId)
      .where("code", "=", code)
      .$if(promoId !== null, (qb) => qb.where("id", "!=", promoId!))
      .executeTakeFirst();
    if (taken) throw conflict("code_taken", "another promotion code already uses this code");
  };

  app.get("/promo-codes", { preHandler: read }, async (request) => {
    const { status } = statusQuery.parse(request.query);
    return db
      .selectFrom("cw_promo_codes")
      .select([...PROMO_COLUMNS, promoUses])
      .where("centre_id", "=", request.user!.centreId)
      .$if(status !== "all", (qb) => qb.where("status", "=", status as "active" | "archived"))
      .orderBy("valid_from", "desc")
      .orderBy("code")
      .execute();
  });

  app.post("/promo-codes", { preHandler: manage }, async (request, reply) => {
    const actor = request.user!;
    const body = promoCreate.parse(request.body);
    validatePromo(body);
    const id = await db.transaction().execute(async (trx) => {
      await assertPromoCodeFree(trx, actor.centreId, body.code, null);
      const created = await trx
        .insertInto("cw_promo_codes")
        .values({
          centre_id: actor.centreId,
          code: body.code,
          kind: body.kind,
          value: body.value,
          valid_from: body.validFrom,
          valid_to: body.validTo,
          max_uses: body.maxUses ?? null,
          created_by: actor.userId,
          ...(body.profiles === undefined ? {} : { profiles: [...new Set(body.profiles)] }),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await audit(trx, actor, "cw_promo_code.created", "cw_promo_code", created.id, { after: body });
      return created.id;
    });
    return reply.status(201).send(await loadPromo(actor.centreId, id));
  });

  app.patch("/promo-codes/:id", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = promoUpdate.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom("cw_promo_codes")
        .select(PROMO_COLUMNS)
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw notFound("promotion code");
      if (before.status !== "active") throw conflict("promo_code_archived", "the promotion code is archived");
      validatePromo({
        code: body.code ?? before.code,
        kind: body.kind ?? before.kind,
        value: body.value ?? before.value,
        validFrom: body.validFrom ?? before.validFrom,
        validTo: body.validTo ?? before.validTo,
      });
      if (body.code !== undefined && body.code !== before.code) await assertPromoCodeFree(trx, actor.centreId, body.code, id);
      await trx
        .updateTable("cw_promo_codes")
        .set({
          ...(body.code === undefined ? {} : { code: body.code }),
          ...(body.kind === undefined ? {} : { kind: body.kind }),
          ...(body.value === undefined ? {} : { value: body.value }),
          ...(body.validFrom === undefined ? {} : { valid_from: body.validFrom }),
          ...(body.validTo === undefined ? {} : { valid_to: body.validTo }),
          ...(body.maxUses === undefined ? {} : { max_uses: body.maxUses }),
          ...(body.profiles === undefined ? {} : { profiles: [...new Set(body.profiles)] }),
        })
        .where("id", "=", id)
        .execute();
      await audit(trx, actor, "cw_promo_code.updated", "cw_promo_code", id, { before, after: body });
    });
    return loadPromo(actor.centreId, id);
  });

  app.post("/promo-codes/:id/archive", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const { reason } = archiveBody.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const archived = await trx
        .updateTable("cw_promo_codes")
        .set({ status: "archived" })
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .returning("id")
        .executeTakeFirst();
      if (!archived) throw notFound("promotion code");
      await audit(trx, actor, "cw_promo_code.archived", "cw_promo_code", id, { after: { status: "archived" }, reason });
    });
    return loadPromo(actor.centreId, id);
  });
};
