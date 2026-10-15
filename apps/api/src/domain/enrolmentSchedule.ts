import { monthlyDueDates, percentOf, planLines, ScheduleError, type PlanItemInput } from "@gcf/shared";
import type { Kysely, Transaction } from "kysely";
import type { Database, PaymentMode } from "../db/types.js";
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
  trainingPaymentModes: "full" | "installments" | "both" | null;
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
      "trainings.payment_modes as trainingPaymentModes",
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
    trainingPaymentModes: row.trainingPaymentModes,
  };
}

export interface ScheduleRequest {
  paymentMode: PaymentMode;
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

/** Checks that the payment mode is allowed for the group and returns the instalments to create. */
export async function buildSchedule(
  db: Kysely<Database> | Transaction<Database>,
  group: GroupBilling,
  request: ScheduleRequest,
  centreId: string,
): Promise<ScheduleLine[]> {
  if (group.kind === "study") {
    if (request.paymentMode !== group.billingMode) {
      throw unprocessable("payment_mode_not_allowed", `this study is billed ${group.billingMode === "monthly" ? "monthly" : "per session"}`);
    }
    if (request.paymentMode === "per_session") return [];
    const firstDue = request.firstDueDate ?? request.effectiveDate;
    const dates = monthlyDueDates(firstDue, group.endDate);
    return dates.map((dueDate) => ({
      label: `${group.label}, ${MONTHS_FR[Number(dueDate.slice(5, 7)) - 1]} ${dueDate.slice(0, 4)}`,
      amount: group.price,
      dueDate,
    }));
  }

  const modes = group.trainingPaymentModes;
  if (request.paymentMode === "full") {
    if (modes === "installments") throw unprocessable("payment_mode_not_allowed", "this training is paid in instalments only");
    return [{ label: `${group.label}, paiement intégral`, amount: group.price, dueDate: request.firstDueDate ?? request.effectiveDate }];
  }
  if (request.paymentMode !== "installments") throw unprocessable("payment_mode_not_allowed", "a training is paid in full or in instalments");
  if (modes === "full") throw unprocessable("payment_mode_not_allowed", "this training is paid in full only");
  if (!request.planId) throw unprocessable("plan_required", "choose a payment plan");
  const plan = await db
    .selectFrom("payment_plans")
    .select(["id", "status", "training_id"])
    .where("id", "=", request.planId)
    .where("centre_id", "=", centreId)
    .executeTakeFirst();
  if (!plan || plan.status !== "active" || plan.training_id !== group.trainingId) {
    throw unprocessable("unknown_plan", "the payment plan does not belong to this training or is archived");
  }
  const items: PlanItemInput[] = await db
    .selectFrom("payment_plan_items")
    .select(["label", "value_kind as valueKind", "value", "due_kind as dueKind", "due_offset_days as dueOffsetDays", "due_date as dueDate"])
    .where("plan_id", "=", plan.id)
    .orderBy("position")
    .execute();
  try {
    return planLines(group.price, items, request.effectiveDate).map((l) => ({ ...l, label: `${group.label}, ${l.label}` }));
  } catch (error) {
    if (error instanceof ScheduleError) throw unprocessable("plan_total_mismatch", error.message);
    throw error;
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
