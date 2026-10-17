import { addDays, CW_CATEGORY_LABELS, formatTnd, isBookableCategory, OCCUPYING_STATUSES, percentOf, todayIn } from "@gcf/shared";
import type { FastifyBaseLogger } from "fastify";
import { sql, type Kysely, type Transaction } from "kysely";
import { writeAudit } from "../../audit.js";
import type { Database } from "../../db/types.js";
import type { CwBookingStatus, CwCategory, CwProfile } from "../../db/types.coworking.js";
import { conflict, forbidden, HttpError, notFound, unprocessable } from "../../errors.js";
import type { Mailer } from "../../mail.js";
import { recordFinancialEvents } from "../financialEvents.js";
import { installmentBalances, lockPayer, settlePayer } from "../ledger.js";
import { activeSubscriptions, computeCoverage, profileOf, releaseUsage, writeUsage, type Coverage } from "./entitlements.js";
import { portalLink, sendMemberMail } from "./memberMail.js";
import { applyPromotion, listPrice, type AppliedPromotion } from "./pricing.js";
import { centreCalendar, coworkingSettings, formatSlots, localInstants, openingOn, type Db } from "./schedule.js";

const occupying = [...OCCUPYING_STATUSES];
/** Check-in opens this long before the start of a booking (rule 12). */
const CHECK_IN_EARLY_MINUTES = 30;

/** Who performs a booking operation: a staff user from the back-office, or the member from the portal. */
export type BookingActor = { source: "staff"; userId: string } | { source: "portal"; memberId: string };

/** What the operations need to e-mail the member after their transaction has committed. */
export interface MailContext {
  mailer: Mailer | null;
  log: FastifyBaseLogger;
  publicOrigin: string | null;
}

export interface BookingInput {
  memberId: string;
  resourceId: string;
  formatId: string;
  /** Local date of the centre, YYYY-MM-DD. */
  date: string;
  /** Local start time, HH:MM, one of the format's start slots that day. */
  startTime: string;
  /** Length of a free format; ignored by the other natures. */
  durationMinutes?: number | undefined;
  promoCode?: string | null | undefined;
  notes?: string | null | undefined;
  /** Staff only: book although portal limits are exceeded (recorded in the audit row). */
  override?: boolean | undefined;
}

export type LimitCode = "beyond_horizon" | "notice_too_short" | "too_many_active_bookings" | "daily_limit_exceeded";

export interface LimitWarning {
  code: LimitCode;
  message: string;
}

export interface Quote {
  memberId: string;
  profile: CwProfile;
  resource: { id: string; code: string; typeId: string; typeName: string; category: CwCategory };
  format: { id: string; label: string; nature: string };
  date: string;
  startTime: string;
  endTime: string;
  minutes: number;
  startsAt: Date;
  endsAt: Date;
  blockedUntil: Date;
  listPrice: number;
  offpeak: boolean;
  coverage: Coverage;
  promotion: AppliedPromotion | null;
  charge: number;
  /** Status the booking would get if it were created now. */
  status: "requested" | "confirmed";
  /** Portal limits the booking exceeds; staff may override them. */
  warnings: LimitWarning[];
}

interface Evaluation extends Quote {
  roomId: string | null;
}

function isExclusionViolation(error: unknown, table: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; table?: unknown };
  return e.code === "23P01" && e.table === table;
}

const slotTaken = () => conflict("slot_taken", "the resource is already booked at that time");
const roomUnavailable = () => conflict("room_unavailable", "the training room shared with this resource is used at that time");

async function roomBusy(db: Db, roomId: string, startsAt: Date, blockedUntil: Date, excludeBookingId: string | null): Promise<boolean> {
  const row = await db
    .selectFrom("room_bookings")
    .select("id")
    .where("room_id", "=", roomId)
    .where("active", "=", true)
    .where(sql<boolean>`period && tstzrange(${startsAt}, ${blockedUntil})`)
    .$if(excludeBookingId !== null, (qb) => qb.where((eb) => eb.or([eb("cw_booking_id", "is", null), eb("cw_booking_id", "!=", excludeBookingId!)])))
    .executeTakeFirst();
  return row !== undefined;
}

async function resourceBusy(db: Db, resourceId: string, startsAt: Date, blockedUntil: Date, excludeBookingId: string | null): Promise<boolean> {
  const row = await db
    .selectFrom("cw_bookings")
    .select("id")
    .where("resource_id", "=", resourceId)
    .where("status", "in", occupying)
    .where(sql<boolean>`tstzrange(starts_at, blocked_until) && tstzrange(${startsAt}, ${blockedUntil})`)
    .$if(excludeBookingId !== null, (qb) => qb.where("id", "!=", excludeBookingId!))
    .executeTakeFirst();
  return row !== undefined;
}

/** Portal-only limits (rule 8): horizon, minimum notice, active bookings and daily minutes of the type. */
async function portalLimits(
  db: Db,
  settings: { booking_horizon_days: number; min_notice_minutes: number; max_active_bookings: number },
  input: { memberId: string; typeId: string; maxMinutesPerDay: number | null; date: string; minutes: number; startsAt: Date },
  today: string,
  timezone: string,
  now: Date,
): Promise<LimitWarning[]> {
  const warnings: LimitWarning[] = [];
  if (input.date > addDays(today, settings.booking_horizon_days)) {
    warnings.push({ code: "beyond_horizon", message: `bookings open ${settings.booking_horizon_days} days ahead` });
  }
  if (input.startsAt.getTime() - now.getTime() < settings.min_notice_minutes * 60_000) {
    warnings.push({ code: "notice_too_short", message: `a booking starts at least ${settings.min_notice_minutes} minutes after it is made` });
  }
  const active = await db
    .selectFrom("cw_bookings")
    .select(sql<number>`count(*)::integer`.as("count"))
    .where("member_id", "=", input.memberId)
    .where("status", "in", occupying)
    .where("ends_at", ">", now)
    .executeTakeFirstOrThrow();
  if (active.count >= settings.max_active_bookings) {
    warnings.push({ code: "too_many_active_bookings", message: `a client holds at most ${settings.max_active_bookings} bookings to come` });
  }
  if (input.maxMinutesPerDay !== null) {
    const day = await db
      .selectFrom("cw_bookings")
      .innerJoin("cw_resources", "cw_resources.id", "cw_bookings.resource_id")
      .select(sql<number>`coalesce(sum(extract(epoch from cw_bookings.ends_at - cw_bookings.starts_at) / 60), 0)::integer`.as("minutes"))
      .where("cw_bookings.member_id", "=", input.memberId)
      .where("cw_resources.type_id", "=", input.typeId)
      .where("cw_bookings.status", "in", ["requested", "confirmed", "checked_in", "completed", "no_show"])
      .where(sql<string>`(cw_bookings.starts_at at time zone ${timezone})::date`, "=", input.date)
      .executeTakeFirstOrThrow();
    if (day.minutes + input.minutes > input.maxMinutesPerDay) {
      warnings.push({ code: "daily_limit_exceeded", message: `a client books at most ${input.maxMinutesPerDay} minutes of this type per day` });
    }
  }
  return warnings;
}

/** Checks a booking against every rule and prices it. With `lock` the promotion code row is locked too. */
async function evaluate(db: Db, centreId: string, actor: BookingActor, input: BookingInput, now: Date, lock: boolean): Promise<Evaluation> {
  if (actor.source === "portal" && actor.memberId !== input.memberId) throw forbidden();
  const member = await db
    .selectFrom("members")
    .select(["id", "kind", "status"])
    .where("id", "=", input.memberId)
    .where("centre_id", "=", centreId)
    .executeTakeFirst();
  if (!member) throw notFound("member");
  if (member.status !== "active") throw unprocessable("member_inactive", "the client account is not active");
  const resource = await db
    .selectFrom("cw_resources as r")
    .innerJoin("cw_resource_types as t", "t.id", "r.type_id")
    .select([
      "r.id",
      "r.code",
      "r.status",
      "r.room_id as roomId",
      "t.id as typeId",
      "t.name as typeName",
      "t.category",
      "t.status as typeStatus",
      "t.public",
      "t.requires_approval as requiresApproval",
      "t.max_minutes_per_day as maxMinutesPerDay",
      "t.buffer_minutes as bufferMinutes",
    ])
    .where("r.id", "=", input.resourceId)
    .where("r.centre_id", "=", centreId)
    .executeTakeFirst();
  if (
    !resource ||
    resource.status !== "active" ||
    resource.typeStatus !== "active" ||
    !isBookableCategory(resource.category) ||
    (actor.source === "portal" && !resource.public)
  ) {
    throw unprocessable("resource_not_bookable", "this resource cannot be booked");
  }
  const format = await db
    .selectFrom("cw_booking_formats")
    .selectAll()
    .where("id", "=", input.formatId)
    .where("centre_id", "=", centreId)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!format || format.type_id !== resource.typeId) throw unprocessable("format_mismatch", "this format does not apply to the resource");

  const day = await openingOn(db, centreId, input.date);
  if (!day.open) throw unprocessable("centre_closed", "the centre is closed that day");
  const slot = formatSlots(format, day.open, input.date, input.durationMinutes).find((s) => s.startTime === input.startTime);
  if (!slot) throw unprocessable("invalid_slot", "this start time is not a slot of the format that day");
  const { timezone } = await centreCalendar(db, centreId);
  const [instants] = await localInstants(db, timezone, [{ date: input.date, startTime: slot.startTime, endTime: slot.endTime }]);
  const { startsAt, endsAt } = instants!;
  if (endsAt <= now) throw unprocessable("slot_past", "this slot is over");
  const blockedUntil = new Date(endsAt.getTime() + resource.bufferMinutes * 60_000);

  const settings = await coworkingSettings(db, centreId);
  const today = todayIn(timezone, now);
  const subscriptions = await activeSubscriptions(db, member.id, input.date);
  const profile = profileOf(member.kind, subscriptions);
  const price = await listPrice(db, format, profile, slot.startTime, slot.minutes, settings.offpeak_from);
  const coverage = await computeCoverage(db, {
    memberId: member.id,
    typeId: resource.typeId,
    date: input.date,
    minutes: slot.minutes,
    listPrice: price.listPrice,
    subscriptions,
  });
  const remaining = price.listPrice - coverage.discount;
  const promotion = input.promoCode ? await applyPromotion(db, centreId, input.promoCode, profile, today, remaining, { lock }) : null;
  const warnings = await portalLimits(
    db,
    settings,
    { memberId: member.id, typeId: resource.typeId, maxMinutesPerDay: resource.maxMinutesPerDay, date: input.date, minutes: slot.minutes, startsAt },
    today,
    timezone,
    now,
  );
  if (actor.source === "portal" && warnings.length) throw unprocessable(warnings[0]!.code, warnings[0]!.message);
  if (await resourceBusy(db, resource.id, startsAt, blockedUntil, null)) throw slotTaken();
  if (resource.roomId && (await roomBusy(db, resource.roomId, startsAt, blockedUntil, null))) throw roomUnavailable();

  const needsApproval = settings.approval_mode === "all" || (settings.approval_mode === "visitors" && profile === "visitor") || resource.requiresApproval;
  return {
    memberId: member.id,
    profile,
    resource: { id: resource.id, code: resource.code, typeId: resource.typeId, typeName: resource.typeName, category: resource.category },
    format: { id: format.id, label: format.label, nature: format.nature },
    date: input.date,
    startTime: slot.startTime,
    endTime: slot.endTime,
    minutes: slot.minutes,
    startsAt,
    endsAt,
    blockedUntil,
    listPrice: price.listPrice,
    offpeak: price.offpeak,
    coverage,
    promotion,
    charge: remaining - (promotion?.discount ?? 0),
    status: actor.source === "staff" || !needsApproval ? "confirmed" : "requested",
    warnings,
    roomId: resource.roomId,
  };
}

/**
 * Prices a booking and tells the status it would get, without writing anything. For the portal a broken limit is
 * an error; for the staff it is returned as a warning to override.
 */
export async function quoteBooking(db: Db, centreId: string, actor: BookingActor, input: BookingInput, now: Date = new Date()): Promise<Quote> {
  const { roomId: _roomId, ...quote } = await evaluate(db, centreId, actor, input, now, false);
  return quote;
}

export interface BookingRecord {
  id: string;
  kind: "booking" | "block";
  status: CwBookingStatus;
  source: "portal" | "staff";
  resourceId: string;
  resourceCode: string;
  roomId: string | null;
  typeId: string;
  typeName: string;
  category: CwCategory;
  floorId: string;
  formatId: string | null;
  formatLabel: string | null;
  memberId: string | null;
  memberName: string | null;
  memberEmail: string | null;
  memberPhone: string | null;
  startsAt: Date;
  endsAt: Date;
  blockedUntil: Date;
  localDate: string;
  startTime: string;
  endTime: string;
  profile: CwProfile | null;
  listPrice: number;
  coveredMinutes: number;
  coverageDiscount: number;
  promoCodeId: string | null;
  promoDiscount: number;
  charge: number;
  lateCancelFee: number;
  checkInCode: string;
  checkedInAt: Date | null;
  requestedAt: Date;
  decidedAt: Date | null;
  refusalReason: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  notes: string | null;
}

/** One booking or block with its resource, client and local date and times. */
export async function loadBooking(db: Db, centreId: string, id: string, options: { lock?: boolean } = {}): Promise<BookingRecord> {
  const { timezone } = await centreCalendar(db, centreId);
  const row = await db
    .selectFrom("cw_bookings as b")
    .innerJoin("cw_resources as r", "r.id", "b.resource_id")
    .innerJoin("cw_resource_types as t", "t.id", "r.type_id")
    .leftJoin("cw_booking_formats as f", "f.id", "b.format_id")
    .leftJoin("members as m", "m.id", "b.member_id")
    .select([
      "b.id",
      "b.kind",
      "b.status",
      "b.source",
      "b.resource_id as resourceId",
      "r.code as resourceCode",
      "r.room_id as roomId",
      "r.type_id as typeId",
      "t.name as typeName",
      "t.category",
      "r.floor_id as floorId",
      "b.format_id as formatId",
      "f.label as formatLabel",
      "b.member_id as memberId",
      sql<string | null>`case when m.id is null then null else m.first_name || coalesce(' ' || m.last_name, '') end`.as("memberName"),
      "m.email as memberEmail",
      "m.phone as memberPhone",
      sql<Date>`b.starts_at`.as("startsAt"),
      sql<Date>`b.ends_at`.as("endsAt"),
      sql<Date>`b.blocked_until`.as("blockedUntil"),
      sql<string>`to_char(b.starts_at at time zone ${timezone}, 'YYYY-MM-DD')`.as("localDate"),
      sql<string>`to_char(b.starts_at at time zone ${timezone}, 'HH24:MI')`.as("startTime"),
      sql<string>`to_char(b.ends_at at time zone ${timezone}, 'HH24:MI')`.as("endTime"),
      "b.profile",
      "b.list_price as listPrice",
      "b.covered_minutes as coveredMinutes",
      "b.coverage_discount as coverageDiscount",
      "b.promo_code_id as promoCodeId",
      "b.promo_discount as promoDiscount",
      "b.charge",
      "b.late_cancel_fee as lateCancelFee",
      "b.check_in_code as checkInCode",
      "b.checked_in_at as checkedInAt",
      "b.requested_at as requestedAt",
      "b.decided_at as decidedAt",
      "b.refusal_reason as refusalReason",
      "b.cancelled_at as cancelledAt",
      "b.cancel_reason as cancelReason",
      "b.notes",
    ])
    .where("b.id", "=", id)
    .where("b.centre_id", "=", centreId)
    .$if(options.lock === true, (qb) => qb.forUpdate("b"))
    .executeTakeFirst();
  if (!row) throw notFound("booking");
  return row;
}

/** Locks the client's payer row, then the booking, in the same order as creation so operations cannot deadlock. */
async function lockBooking(trx: Transaction<Database>, centreId: string, id: string): Promise<BookingRecord> {
  const owner = await trx.selectFrom("cw_bookings").select("member_id").where("id", "=", id).where("centre_id", "=", centreId).executeTakeFirst();
  if (!owner) throw notFound("booking");
  if (owner.member_id) await lockPayer(trx, { kind: "member", id: owner.member_id }, centreId);
  return loadBooking(trx, centreId, id, { lock: true });
}

const frenchDate = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
const slotText = (b: Pick<BookingRecord, "category" | "resourceCode" | "localDate" | "startTime" | "endTime">) =>
  `${CW_CATEGORY_LABELS.fr[b.category]} ${b.resourceCode}, ${frenchDate(b.localDate)} ${b.startTime}-${b.endTime}`;

/** Applies the member's credit to new charges. A portal operation has no staff user to record on allocations. */
/** A charge of a booking due on `dueDate`, with its financial event. */
async function issueCharge(
  trx: Transaction<Database>,
  centreId: string,
  booking: { id: string; memberId: string },
  label: string,
  amount: number,
  dueDate: string,
  userId: string | null,
): Promise<string> {
  const charge = await trx
    .insertInto("installments")
    .values({
      centre_id: centreId,
      enrolment_id: null,
      member_id: booking.memberId,
      cw_booking_id: booking.id,
      label,
      kind: "charge",
      amount,
      due_date: dueDate,
      original_due_date: dueDate,
      discount_status: null,
      created_by: userId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await recordFinancialEvents(trx, [
    { centreId, type: "installment_issued", amount, userId, installmentId: charge.id, memberId: booking.memberId, cwBookingId: booking.id },
  ]);
  return charge.id;
}

/** The booking charge, created when a booking is confirmed and costs something (rule 10). */
async function issueBookingCharge(trx: Transaction<Database>, centreId: string, booking: BookingRecord, userId: string | null): Promise<void> {
  if (booking.charge <= 0 || !booking.memberId) return;
  await issueCharge(
    trx,
    centreId,
    { id: booking.id, memberId: booking.memberId },
    `Coworking : ${slotText(booking)}`,
    booking.charge,
    booking.localDate,
    userId,
  );
  await settlePayer(trx, centreId, { kind: "member", id: booking.memberId }, userId);
}

/** Frees the training room shared with a resource once the booking no longer occupies it. */
export async function deactivateRoomBooking(trx: Transaction<Database>, bookingIds: string[]): Promise<void> {
  if (bookingIds.length === 0) return;
  await trx.updateTable("room_bookings").set({ active: false }).where("cw_booking_id", "in", bookingIds).where("active", "=", true).execute();
}

async function insertRoomBooking(trx: Transaction<Database>, centreId: string, roomId: string, bookingId: string, startsAt: Date, until: Date): Promise<void> {
  try {
    await trx
      .insertInto("room_bookings")
      .values({
        centre_id: centreId,
        room_id: roomId,
        period: sql<string>`tstzrange(${startsAt}, ${until})` as unknown as string,
        session_id: null,
        cw_booking_id: bookingId,
      })
      .execute();
  } catch (error) {
    if (isExclusionViolation(error, "room_bookings")) throw roomUnavailable();
    throw error;
  }
}

const actorUser = (actor: BookingActor) => (actor.source === "staff" ? actor.userId : null);

export interface CreatedBooking {
  booking: BookingRecord;
  quote: Quote;
  overridden: LimitCode[];
}

/**
 * Creates a booking after checking every rule again inside one transaction. The member row is locked first so
 * quota use is serialised; the exclusion constraint settles two clients racing for the same slot (409 slot_taken).
 * A resource shared with a training room also books the room. Staff bookings are confirmed at once and, when they
 * cost something, create their charge.
 */
export async function createBooking(
  db: Kysely<Database>,
  centreId: string,
  actor: BookingActor,
  input: BookingInput,
  now: Date = new Date(),
): Promise<CreatedBooking> {
  return db.transaction().execute(async (trx) => {
    await lockPayer(trx, { kind: "member", id: input.memberId }, centreId);
    const evaluation = await evaluate(trx, centreId, actor, input, now, true);
    if (evaluation.warnings.length && !input.override) {
      throw new HttpError(422, "limits_exceeded", "the booking exceeds the portal limits; confirm to override them", { warnings: evaluation.warnings });
    }
    const userId = actorUser(actor);
    let bookingId: string;
    try {
      const row = await trx
        .insertInto("cw_bookings")
        .values({
          centre_id: centreId,
          kind: "booking",
          resource_id: evaluation.resource.id,
          member_id: evaluation.memberId,
          format_id: evaluation.format.id,
          starts_at: evaluation.startsAt,
          ends_at: evaluation.endsAt,
          blocked_until: evaluation.blockedUntil,
          status: evaluation.status,
          source: actor.source,
          profile: evaluation.profile,
          list_price: evaluation.listPrice,
          promo_code_id: evaluation.promotion?.id ?? null,
          promo_discount: evaluation.promotion?.discount ?? 0,
          covered_minutes: evaluation.coverage.coveredMinutes,
          coverage_discount: evaluation.coverage.discount,
          charge: evaluation.charge,
          requested_at: now,
          notes: input.notes ?? null,
          created_by: userId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      bookingId = row.id;
    } catch (error) {
      if (isExclusionViolation(error, "cw_bookings")) throw slotTaken();
      throw error;
    }
    if (evaluation.roomId) await insertRoomBooking(trx, centreId, evaluation.roomId, bookingId, evaluation.startsAt, evaluation.blockedUntil);
    await writeUsage(trx, centreId, bookingId, evaluation.coverage);
    const booking = await loadBooking(trx, centreId, bookingId);
    if (booking.status === "confirmed") await issueBookingCharge(trx, centreId, booking, userId);
    const overridden = evaluation.warnings.map((w) => w.code);
    await writeAudit(trx, {
      centreId,
      userId,
      action: "cw_booking.created",
      objectType: "cw_booking",
      objectId: bookingId,
      after: {
        source: actor.source,
        memberId: evaluation.memberId,
        resourceId: evaluation.resource.id,
        formatId: evaluation.format.id,
        startsAt: evaluation.startsAt,
        endsAt: evaluation.endsAt,
        status: evaluation.status,
        profile: evaluation.profile,
        listPrice: evaluation.listPrice,
        coverage: evaluation.coverage,
        promotion: evaluation.promotion,
        charge: evaluation.charge,
        ...(overridden.length ? { overriddenLimits: overridden } : {}),
      },
      reason: overridden.length ? `limites du portail dépassées : ${overridden.join(", ")}` : null,
    });
    const { roomId: _roomId, ...quote } = evaluation;
    return { booking, quote, overridden };
  });
}

async function centreName(db: Db, centreId: string): Promise<string> {
  const centre = await db.selectFrom("centres").select("name").where("id", "=", centreId).executeTakeFirstOrThrow();
  return centre.name;
}

/** E-mails the member about a decision on a booking, after commit; members without an e-mail address are skipped. */
async function notifyMember(
  db: Kysely<Database>,
  mail: MailContext,
  centreId: string,
  booking: BookingRecord,
  subject: string,
  lines: string[],
  sentBy: string | null,
): Promise<void> {
  if (!booking.memberId || !booking.memberEmail) return;
  const link = portalLink(mail.publicOrigin, "/reservations");
  const text = [`Bonjour ${booking.memberName},`, "", ...lines, "", ...(link ? [`Vos réservations : ${link}`, ""] : []), await centreName(db, centreId)].join(
    "\n",
  );
  await sendMemberMail(db, mail.mailer, mail.log, { centreId, memberId: booking.memberId, kind: "booking", to: booking.memberEmail, subject, text, sentBy });
}

const slotLines = (b: BookingRecord) => [
  `- ${CW_CATEGORY_LABELS.fr[b.category]} ${b.resourceCode}`,
  `- le ${frenchDate(b.localDate)} de ${b.startTime} à ${b.endTime}`,
];
const amountLine = (label: string, amount: number) => `- ${label} : ${formatTnd(amount)} TND, à régler à l'accueil`;

/** Accepts a request (requested to confirmed): the slot must still be ahead and the resource in service. */
export async function approveBooking(
  db: Kysely<Database>,
  mail: MailContext,
  centreId: string,
  userId: string,
  id: string,
  now: Date = new Date(),
): Promise<BookingRecord> {
  const booking = await db.transaction().execute(async (trx) => {
    const before = await lockBooking(trx, centreId, id);
    if (before.kind !== "booking" || before.status !== "requested") throw conflict("already_decided", "this booking is not waiting for a decision");
    if (before.startsAt <= now) throw conflict("request_expired", "the booking has already started");
    const resource = await trx.selectFrom("cw_resources").select("status").where("id", "=", before.resourceId).executeTakeFirstOrThrow();
    if (resource.status !== "active") throw conflict("resource_unavailable", "the resource is out of service");
    await trx.updateTable("cw_bookings").set({ status: "confirmed", decided_at: now, decided_by: userId, updated_at: now }).where("id", "=", id).execute();
    const after = await loadBooking(trx, centreId, id);
    await issueBookingCharge(trx, centreId, after, userId);
    await writeAudit(trx, {
      centreId,
      userId,
      action: "cw_booking.approved",
      objectType: "cw_booking",
      objectId: id,
      before: { status: before.status },
      after: { status: after.status, charge: after.charge },
    });
    return after;
  });
  await notifyMember(
    db,
    mail,
    centreId,
    booking,
    "Réservation confirmée",
    ["Votre réservation est confirmée :", ...slotLines(booking), booking.charge > 0 ? amountLine("montant", booking.charge) : "- aucun montant à régler"],
    userId,
  );
  return booking;
}

/** Refuses a request with a reason: what it took from quotas and packs is given back. */
export async function refuseBooking(
  db: Kysely<Database>,
  mail: MailContext,
  centreId: string,
  userId: string,
  id: string,
  reason: string,
  now: Date = new Date(),
): Promise<BookingRecord> {
  const booking = await db.transaction().execute(async (trx) => {
    const before = await lockBooking(trx, centreId, id);
    if (before.kind !== "booking" || before.status !== "requested") throw conflict("already_decided", "this booking is not waiting for a decision");
    await trx
      .updateTable("cw_bookings")
      .set({ status: "refused", refusal_reason: reason, decided_at: now, decided_by: userId, updated_at: now })
      .where("id", "=", id)
      .execute();
    await releaseUsage(trx, [id]);
    await deactivateRoomBooking(trx, [id]);
    await writeAudit(trx, {
      centreId,
      userId,
      action: "cw_booking.refused",
      objectType: "cw_booking",
      objectId: id,
      before: { status: before.status },
      after: { status: "refused" },
      reason,
    });
    return loadBooking(trx, centreId, id);
  });
  await notifyMember(
    db,
    mail,
    centreId,
    booking,
    "Réservation refusée",
    ["Votre demande de réservation n'a pas pu être acceptée :", ...slotLines(booking), `- motif : ${reason}`],
    userId,
  );
  return booking;
}

export interface CancelResult {
  booking: BookingRecord;
  /** True when cancelled in time: quotas given back and no fee. */
  free: boolean;
  fee: number;
}

/** Rule 11: a request or a booking cancelled before its start minus free_cancel_hours is free, otherwise a fee. */
export function cancellationTerms(
  booking: { status: string; startsAt: Date; charge: number },
  settings: { free_cancel_hours: number; late_cancel_fee_bp: number },
  now: Date,
): { free: boolean; fee: number; freeUntil: Date } {
  const freeUntil = new Date(booking.startsAt.getTime() - settings.free_cancel_hours * 3_600_000);
  const free = booking.status === "requested" || now < freeUntil;
  return { free, fee: free ? 0 : percentOf(booking.charge, settings.late_cancel_fee_bp), freeUntil };
}

/**
 * Cancels a request or a confirmed booking (rule 11), by the staff or by the member who owns it. In time (before
 * the start minus free_cancel_hours) the quotas are given back and the unpaid charge is cancelled; later the quotas
 * stay used, the unpaid charge is cancelled and a fee charge is created. A charge that already received money
 * blocks the cancellation (409 installment_paid).
 */
export async function cancelBooking(
  db: Kysely<Database>,
  mail: MailContext,
  centreId: string,
  actor: BookingActor,
  id: string,
  reason: string,
  now: Date = new Date(),
): Promise<CancelResult> {
  const userId = actorUser(actor);
  const result = await db.transaction().execute(async (trx) => {
    const before = await lockBooking(trx, centreId, id);
    if (actor.source === "portal" && before.memberId !== actor.memberId) throw notFound("booking");
    if (before.kind !== "booking" || (before.status !== "requested" && before.status !== "confirmed")) {
      throw conflict("not_cancellable", "only a request or a confirmed booking can be cancelled");
    }
    const settings = await coworkingSettings(trx, centreId);
    const { free, fee } = cancellationTerms(before, settings, now);
    const chargeIds = (
      await trx.selectFrom("installments").select("id").where("cw_booking_id", "=", id).where("kind", "=", "charge").where("status", "=", "open").execute()
    ).map((c) => c.id);
    const charges = chargeIds.length ? await installmentBalances(trx, centreId, { installmentIds: chargeIds }) : [];
    if (charges.some((c) => c.paid > 0)) throw conflict("installment_paid", "a charge of this booking has received a payment; cancel the payment first");
    await trx
      .updateTable("cw_bookings")
      .set({ status: "cancelled", cancelled_at: now, cancelled_by: userId, cancel_reason: reason, late_cancel_fee: fee, updated_at: now })
      .where("id", "=", id)
      .execute();
    for (const charge of charges) {
      await trx
        .updateTable("installments")
        .set({ status: "cancelled", cancelled_at: now, cancelled_by: userId, cancel_reason: `réservation annulée : ${reason}` })
        .where("id", "=", charge.id)
        .execute();
    }
    await recordFinancialEvents(
      trx,
      charges.map((c) => ({
        centreId,
        type: "installment_cancelled" as const,
        amount: -c.amount,
        userId,
        installmentId: c.id,
        memberId: before.memberId,
        cwBookingId: id,
      })),
    );
    if (free) await releaseUsage(trx, [id]);
    await deactivateRoomBooking(trx, [id]);
    if (fee > 0) {
      const { timezone } = await centreCalendar(trx, centreId);
      await issueCharge(
        trx,
        centreId,
        { id, memberId: before.memberId! },
        `Coworking : frais d'annulation tardive, ${slotText(before)}`,
        fee,
        todayIn(timezone, now),
        userId,
      );
      await settlePayer(trx, centreId, { kind: "member", id: before.memberId! }, userId);
    }
    await writeAudit(trx, {
      centreId,
      userId,
      action: "cw_booking.cancelled",
      objectType: "cw_booking",
      objectId: id,
      before: { status: before.status },
      after: { status: "cancelled", by: actor.source, free, fee, cancelledCharges: charges.length },
      reason,
    });
    return { booking: await loadBooking(trx, centreId, id), free, fee };
  });
  if (actor.source === "staff") {
    await notifyMember(
      db,
      mail,
      centreId,
      result.booking,
      "Réservation annulée",
      [
        "Votre réservation a été annulée par l'accueil :",
        ...slotLines(result.booking),
        `- motif : ${reason}`,
        ...(result.fee > 0 ? [amountLine("frais d'annulation", result.fee)] : []),
      ],
      userId,
    );
  }
  return result;
}

/** Moves a request or a confirmed booking to another free resource of the same type at the same time; the price is kept. */
export async function reassignBooking(
  db: Kysely<Database>,
  centreId: string,
  userId: string,
  id: string,
  resourceId: string,
  now: Date = new Date(),
): Promise<BookingRecord> {
  return db.transaction().execute(async (trx) => {
    const before = await lockBooking(trx, centreId, id);
    if (before.kind !== "booking" || (before.status !== "requested" && before.status !== "confirmed")) {
      throw conflict("not_reassignable", "only a request or a confirmed booking can move");
    }
    if (before.endsAt <= now) throw conflict("already_ended", "the booking is over");
    const target = await trx
      .selectFrom("cw_resources")
      .select(["id", "type_id", "status", "room_id"])
      .where("id", "=", resourceId)
      .where("centre_id", "=", centreId)
      .executeTakeFirst();
    if (!target || target.status !== "active" || target.type_id !== before.typeId || target.id === before.resourceId) {
      throw unprocessable("invalid_resource", "choose another active resource of the same type");
    }
    if (target.room_id && (await roomBusy(trx, target.room_id, before.startsAt, before.blockedUntil, id))) throw roomUnavailable();
    try {
      await trx.updateTable("cw_bookings").set({ resource_id: resourceId, updated_at: now }).where("id", "=", id).execute();
    } catch (error) {
      if (isExclusionViolation(error, "cw_bookings")) throw slotTaken();
      throw error;
    }
    await deactivateRoomBooking(trx, [id]);
    if (target.room_id) await insertRoomBooking(trx, centreId, target.room_id, id, before.startsAt, before.blockedUntil);
    await writeAudit(trx, {
      centreId,
      userId,
      action: "cw_booking.reassigned",
      objectType: "cw_booking",
      objectId: id,
      before: { resourceId: before.resourceId },
      after: { resourceId },
    });
    return loadBooking(trx, centreId, id);
  });
}

/** How the arrival was recorded: by the staff, or by scanning the booking's QR code. */
export type CheckInBy = { source: "staff"; userId: string } | { source: "qr"; userId: string | null };

/**
 * Records the arrival of the client (rule 12), from 30 minutes before the start until the end, by booking id or
 * by the booking's check-in code. Writes the access event.
 */
export async function checkIn(
  db: Kysely<Database>,
  centreId: string,
  target: { bookingId: string } | { code: string },
  by: CheckInBy,
  now: Date = new Date(),
): Promise<BookingRecord> {
  return db.transaction().execute(async (trx) => {
    let id: string;
    if ("bookingId" in target) id = target.bookingId;
    else {
      const found = await trx
        .selectFrom("cw_bookings")
        .select("id")
        .where("check_in_code", "=", target.code)
        .where("centre_id", "=", centreId)
        .executeTakeFirst();
      if (!found) throw notFound("booking");
      id = found.id;
    }
    const before = await lockBooking(trx, centreId, id);
    if (before.kind !== "booking") throw notFound("booking");
    if (before.status === "checked_in") throw conflict("already_checked_in", "the client has already checked in");
    if (before.status !== "confirmed") throw conflict("not_confirmed", "only a confirmed booking can be checked in");
    if (now.getTime() < before.startsAt.getTime() - CHECK_IN_EARLY_MINUTES * 60_000 || now >= before.endsAt) {
      throw conflict("check_in_closed", "check-in opens 30 minutes before the start and closes at the end");
    }
    await trx.updateTable("cw_bookings").set({ status: "checked_in", checked_in_at: now, updated_at: now }).where("id", "=", id).execute();
    await trx
      .insertInto("cw_access_events")
      .values({ centre_id: centreId, member_id: before.memberId!, booking_id: id, at: now, source: by.source, recorded_by: by.userId })
      .execute();
    await writeAudit(trx, {
      centreId,
      userId: by.userId,
      action: "cw_booking.checked_in",
      objectType: "cw_booking",
      objectId: id,
      before: { status: before.status },
      after: { status: "checked_in", source: by.source },
    });
    return loadBooking(trx, centreId, id);
  });
}

/**
 * Frees a running booking now ("libérer"): it ends now, its buffer is dropped, its status becomes completed and
 * its charge does not change. A shared training room is freed from now too.
 */
export async function releaseBooking(db: Kysely<Database>, centreId: string, userId: string, id: string, now: Date = new Date()): Promise<BookingRecord> {
  return db.transaction().execute(async (trx) => {
    const before = await lockBooking(trx, centreId, id);
    if (before.kind !== "booking" || (before.status !== "checked_in" && before.status !== "confirmed")) {
      throw conflict("not_running", "only a running booking can be released");
    }
    if (now <= before.startsAt) throw conflict("not_running", "the booking has not started yet");
    if (now >= before.endsAt) throw conflict("already_ended", "the booking is over");
    await trx.updateTable("cw_bookings").set({ status: "completed", ends_at: now, blocked_until: now, updated_at: now }).where("id", "=", id).execute();
    await sql`update room_bookings set period = tstzrange(lower(period), ${now}) where cw_booking_id = ${id} and active`.execute(trx);
    await writeAudit(trx, {
      centreId,
      userId,
      action: "cw_booking.released",
      objectType: "cw_booking",
      objectId: id,
      before: { status: before.status, endsAt: before.endsAt },
      after: { status: "completed", endsAt: now },
    });
    return loadBooking(trx, centreId, id);
  });
}

export interface BlockInput {
  resourceId: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  reason: string;
}

/** Blocks a resource for maintenance or a private event (rule 14): no client, confirmed, staff only, reason in notes. */
export async function createBlock(db: Kysely<Database>, centreId: string, userId: string, input: BlockInput, now: Date = new Date()): Promise<BookingRecord> {
  return db.transaction().execute(async (trx) => {
    const resource = await trx
      .selectFrom("cw_resources")
      .select(["id", "status", "room_id"])
      .where("id", "=", input.resourceId)
      .where("centre_id", "=", centreId)
      .executeTakeFirst();
    if (!resource || resource.status === "archived") throw unprocessable("invalid_resource", "the resource does not exist or is archived");
    const { timezone } = await centreCalendar(trx, centreId);
    const [start, end] = await localInstants(trx, timezone, [
      { date: input.startDate, startTime: input.startTime, endTime: input.startTime },
      { date: input.endDate, startTime: input.endTime, endTime: input.endTime },
    ]);
    const startsAt = start!.startsAt;
    const endsAt = end!.startsAt;
    if (endsAt <= startsAt) throw unprocessable("invalid_period", "the end must be after the start");
    if (endsAt <= now) throw unprocessable("slot_past", "this period is over");
    if (resource.room_id && (await roomBusy(trx, resource.room_id, startsAt, endsAt, null))) throw roomUnavailable();
    let blockId: string;
    try {
      const row = await trx
        .insertInto("cw_bookings")
        .values({
          centre_id: centreId,
          kind: "block",
          resource_id: resource.id,
          member_id: null,
          format_id: null,
          starts_at: startsAt,
          ends_at: endsAt,
          blocked_until: endsAt,
          status: "confirmed",
          source: "staff",
          profile: null,
          requested_at: now,
          notes: input.reason,
          created_by: userId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      blockId = row.id;
    } catch (error) {
      if (isExclusionViolation(error, "cw_bookings")) throw slotTaken();
      throw error;
    }
    if (resource.room_id) await insertRoomBooking(trx, centreId, resource.room_id, blockId, startsAt, endsAt);
    await writeAudit(trx, {
      centreId,
      userId,
      action: "cw_block.created",
      objectType: "cw_booking",
      objectId: blockId,
      after: { resourceId: resource.id, startsAt, endsAt },
      reason: input.reason,
    });
    return loadBooking(trx, centreId, blockId);
  });
}

/** Removes a block that still occupies its resource; the row is kept as cancelled for the history. */
export async function removeBlock(db: Kysely<Database>, centreId: string, userId: string, id: string, now: Date = new Date()): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const before = await loadBooking(trx, centreId, id, { lock: true });
    if (before.kind !== "block") throw notFound("block");
    if (before.status !== "confirmed") throw conflict("not_cancellable", "this block no longer occupies the resource");
    await trx
      .updateTable("cw_bookings")
      .set({ status: "cancelled", cancelled_at: now, cancelled_by: userId, cancel_reason: "blocage retiré", updated_at: now })
      .where("id", "=", id)
      .execute();
    await deactivateRoomBooking(trx, [id]);
    await writeAudit(trx, {
      centreId,
      userId,
      action: "cw_block.removed",
      objectType: "cw_booking",
      objectId: id,
      before: { status: before.status, startsAt: before.startsAt, endsAt: before.endsAt, notes: before.notes },
    });
  });
}
