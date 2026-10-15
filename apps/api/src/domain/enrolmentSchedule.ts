import { monthlyDueDates, percentOf, planLines, ScheduleError, type PlanItemInput } from "@gcf/shared";
import type { Kysely, Transaction } from "kysely";
import type { Database, PaymentMode, PlanKind } from "../db/types.js";
import { notFound, unprocessable } from "../errors.js";

export interface GroupBilling {
  groupId: string;
  groupName: string;
  kind: "study" | "training";
  status: "active" | "archived";
  capacity: number;
  endDate: string;
  instructorId: string;
  roomId: string | null;
  studyId: string | null;
  trainingId: string | null;
  label: string;
  price: number;
  billingMode: "monthly" | "per_session" | null;
}

export async function loadGroupBilling(db: Kysely<Database> | Transaction<Database>, groupId: string, centreId: string): Promise<GroupBilling> {
  const row = await db
    .selectFrom("groups")
    .leftJoin("studies", "studies.id", "groups.study_id")
    .leftJoin("training_sessions", "training_sessions.id", "groups.training_session_id")
    .leftJoin("trainings", "trainings.id", "training_sessions.training_id")
    .select([
      "groups.id",
      "groups.name",
      "groups.kind",
      "groups.status",
      "groups.capacity",
      "groups.end_date as endDate",
      "groups.instructor_id as instructorId",
      "groups.room_id as roomId",
      "groups.price_override as priceOverride",
      "studies.id as studyId",
      "studies.name as studyName",
      "studies.price as studyPrice",
      "studies.billing_mode as billingMode",
      "trainings.id as trainingId",
      "trainings.title as trainingTitle",
      "trainings.price as trainingPrice",
    ])
    .where("groups.id", "=", groupId)
    .where("groups.centre_id", "=", centreId)
    .executeTakeFirst();
  if (!row) throw notFound("group");
  const isStudy = row.kind === "study";
  return {
    groupId: row.id,
    groupName: row.name,
    kind: row.kind,
    status: row.status,
    capacity: row.capacity,
    endDate: row.endDate,
    instructorId: row.instructorId,
    roomId: row.roomId,
    studyId: row.studyId,
    trainingId: row.trainingId,
    label: `${isStudy ? row.studyName : row.trainingTitle} - ${row.name}`,
    price: row.priceOverride ?? (isStudy ? row.studyPrice : row.trainingPrice) ?? 0,
    billingMode: row.billingMode,
  };
}

export interface ScheduleRequest {
  paymentMode?: PaymentMode | undefined;
  effectiveDate: string;
  planId?: string | undefined;
  firstDueDate?: string | undefined;
}

export interface ScheduleLine {
  label: string;
  amount: number;
  dueDate: string;
}

const MONTHS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

export interface TrainingPlan {
  id: string;
  name: string;
  kind: PlanKind;
  amount: number | null;
  absenceBilled: boolean | null;
}

/** The formula an enrolment in a training is sold under: it must be an active formula of that training. */
export async function loadTrainingPlan(
  db: Kysely<Database> | Transaction<Database>,
  group: GroupBilling,
  planId: string | undefined,
  centreId: string,
): Promise<TrainingPlan> {
  if (!planId) throw unprocessable("plan_required", "choose a formula for this training");
  const plan = await db
    .selectFrom("payment_plans")
    .select(["id", "name", "kind", "amount", "absence_billed as absenceBilled", "status", "training_id as trainingId"])
    .where("id", "=", planId)
    .where("centre_id", "=", centreId)
    .executeTakeFirst();
  if (!plan || plan.status !== "active" || plan.trainingId !== group.trainingId) {
    throw unprocessable("unknown_plan", "the formula does not belong to this training or is archived");
  }
  return { id: plan.id, name: plan.name, kind: plan.kind, amount: plan.amount, absenceBilled: plan.absenceBilled };
}

/** Payment mode, formula and per-session tariff an enrolment is created with. */
export interface EnrolmentTerms {
  paymentMode: PaymentMode;
  planId: string | null;
  sessionPrice: number | null;
  sessionAbsenceBilled: boolean | null;
}

/**
 * A private lesson is billed the way its offer says (monthly or per session); a training is billed by the formula
 * chosen at enrolment. A payment mode sent by the client must agree with that.
 */
export async function resolveTerms(
  db: Kysely<Database> | Transaction<Database>,
  group: GroupBilling,
  request: { paymentMode?: PaymentMode | undefined; planId?: string | undefined },
  centreId: string,
): Promise<{ terms: EnrolmentTerms; plan: TrainingPlan | null }> {
  if (group.kind === "study") {
    const mode = group.billingMode ?? "monthly";
    if (request.paymentMode !== undefined && request.paymentMode !== mode) {
      throw unprocessable("payment_mode_not_allowed", `this offer is billed ${mode === "monthly" ? "monthly" : "per session"}`);
    }
    return { terms: { paymentMode: mode, planId: null, sessionPrice: null, sessionAbsenceBilled: null }, plan: null };
  }
  const plan = await loadTrainingPlan(db, group, request.planId, centreId);
  if (request.paymentMode !== undefined && request.paymentMode !== plan.kind) {
    throw unprocessable("payment_mode_not_allowed", "the payment mode does not match the chosen formula");
  }
  return {
    terms: {
      paymentMode: plan.kind,
      planId: plan.id,
      sessionPrice: plan.kind === "per_session" ? plan.amount : null,
      sessionAbsenceBilled: plan.kind === "per_session" ? plan.absenceBilled : null,
    },
    plan,
  };
}

function monthlyLines(label: string, amount: number, firstDue: string, endDate: string): ScheduleLine[] {
  return monthlyDueDates(firstDue, endDate).map((dueDate) => ({
    label: `${label}, ${MONTHS_FR[Number(dueDate.slice(5, 7)) - 1]} ${dueDate.slice(0, 4)}`,
    amount,
    dueDate,
  }));
}

/** The instalments an enrolment creates up front. Per-session billing creates none: each validated session does. */
export async function buildSchedule(
  db: Kysely<Database> | Transaction<Database>,
  group: GroupBilling,
  request: ScheduleRequest,
  centreId: string,
): Promise<ScheduleLine[]> {
  const firstDue = request.firstDueDate ?? request.effectiveDate;
  if (group.kind === "study") {
    const { terms } = await resolveTerms(db, group, request, centreId);
    if (terms.paymentMode === "per_session") return [];
    return monthlyLines(group.label, group.price, firstDue, group.endDate);
  }
  const { plan } = await resolveTerms(db, group, request, centreId);
  switch (plan!.kind) {
    case "per_session":
      return [];
    case "monthly":
      return monthlyLines(group.label, plan!.amount!, firstDue, group.endDate);
    case "full":
      return [{ label: `${group.label}, paiement intégral`, amount: plan!.amount ?? group.price, dueDate: firstDue }];
    case "installments": {
      const items: PlanItemInput[] = await db
        .selectFrom("payment_plan_items")
        .select(["label", "value_kind as valueKind", "value", "due_kind as dueKind", "due_offset_days as dueOffsetDays", "due_date as dueDate"])
        .where("plan_id", "=", plan!.id)
        .orderBy("position")
        .execute();
      try {
        return planLines(group.price, items, request.effectiveDate).map((l) => ({ ...l, label: `${group.label}, ${l.label}` }));
      } catch (error) {
        if (error instanceof ScheduleError) throw unprocessable("plan_total_mismatch", error.message);
        throw error;
      }
    }
  }
}

export interface DiscountRequest {
  kind: "percent" | "amount";
  value: number;
  reason: string;
}

/** A discount is a single negative line on the schedule; it can never exceed the charges it reduces. */
export function discountAmount(lines: ScheduleLine[], discount: DiscountRequest): number {
  const total = lines.reduce((s, l) => s + l.amount, 0);
  if (total === 0) throw unprocessable("discount_not_applicable", "there is no upfront schedule to discount");
  const amount = discount.kind === "percent" ? percentOf(total, discount.value) : discount.value;
  if (amount <= 0 || amount > total) throw unprocessable("invalid_discount", "the discount must be positive and cannot exceed the schedule total");
  return amount;
}
