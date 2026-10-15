import { createHash, randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { writeAudit } from "../audit.js";
import type { Database } from "../db/types.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { recordFinancialEvents } from "./financialEvents.js";
import { centreClock } from "./ledger.js";
import { computeCandidates, monthBounds, type PayCandidate, type PayWarning } from "./payrollCalc.js";
import { renderSettlement } from "./payslipPdf.js";

type Trx = Transaction<Database>;
interface Actor {
  centreId: string;
  userId: string;
}

const EMPLOYMENT_FR = { salaried: "salarié", freelance: "freelance", contractor: "vacataire" } as const;

/** Serialises every pay operation on one instructor: calculations and settlements never interleave. */
async function lockInstructor(trx: Trx, instructorId: string, centreId: string) {
  const row = await trx
    .selectFrom("instructors")
    .select(["id", "first_name as firstName", "last_name as lastName", "employment"])
    .where("id", "=", instructorId)
    .where("centre_id", "=", centreId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw notFound("instructor");
  return row;
}

/** Axes of the financial journal for an item's group. */
async function axesOf(trx: Trx, groupId: string | null) {
  if (!groupId) return { groupId: null, studyId: null, trainingId: null };
  const g = await trx
    .selectFrom("groups")
    .leftJoin("training_sessions", "training_sessions.id", "groups.training_session_id")
    .select(["groups.study_id as studyId", "training_sessions.training_id as trainingId"])
    .where("groups.id", "=", groupId)
    .executeTakeFirstOrThrow();
  return { groupId, studyId: g.studyId, trainingId: g.trainingId };
}

const sameCalculation = (item: { amount: number; base: number; rate_numerator: number; rate_denominator: number; sessionIds: string[] }, c: PayCandidate) =>
  item.amount === c.amount &&
  item.base === c.base &&
  item.rate_numerator === c.rate.numerator &&
  item.rate_denominator === c.rate.denominator &&
  item.sessionIds.length === c.sessionIds.length &&
  c.sessionIds.every((id) => item.sessionIds.includes(id));

export interface CalculationResult {
  created: number;
  unchanged: number;
  replaced: number;
  warnings: PayWarning[];
}

/**
 * Calculates an instructor's items whose period ends in the range. Validated items are never touched and their
 * sessions are left out; a calculated item that the rules no longer produce identically is cancelled and replaced,
 * so the history of every calculation is kept.
 */
export async function calculateItems(trx: Trx, actor: Actor, instructorId: string, range: { from: string; to: string }): Promise<CalculationResult> {
  await lockInstructor(trx, instructorId, actor.centreId);
  const { candidates, warnings } = await computeCandidates(trx, actor.centreId, { ...range, instructorId, excludeValidated: true });
  const existing = await trx
    .selectFrom("pay_items")
    .select(["id", "rule_id", "group_id", "period_key", "status", "amount", "base", "rate_numerator", "rate_denominator"])
    .where("centre_id", "=", actor.centreId)
    .where("instructor_id", "=", instructorId)
    .where("kind", "=", "rule")
    .where("status", "in", ["calculated", "validated"])
    .where("period_end", ">=", range.from)
    .where("period_end", "<=", range.to)
    .execute();
  const links = existing.length
    ? await trx
        .selectFrom("pay_item_sessions")
        .select(["item_id", "session_id"])
        .where(
          "item_id",
          "in",
          existing.map((e) => e.id),
        )
        .where("active", "=", true)
        .execute()
    : [];
  const keyOf = (ruleId: string | null, groupId: string | null, periodKey: string) => `${ruleId}|${groupId ?? ""}|${periodKey}`;
  const byKey = new Map(
    existing.map((e) => [keyOf(e.rule_id, e.group_id, e.period_key), { ...e, sessionIds: links.filter((l) => l.item_id === e.id).map((l) => l.session_id) }]),
  );

  let created = 0;
  let unchanged = 0;
  let replaced = 0;
  const seen = new Set<string>();
  const cancel = async (id: string, reason: string) => {
    await trx
      .updateTable("pay_items")
      .set({ status: "cancelled", cancelled_at: new Date(), cancelled_by: actor.userId, cancel_reason: reason })
      .where("id", "=", id)
      .execute();
    await trx.updateTable("pay_item_sessions").set({ active: false }).where("item_id", "=", id).execute();
  };
  for (const c of candidates) {
    const key = keyOf(c.rule.id, c.groupId, c.periodKey);
    seen.add(key);
    const current = byKey.get(key);
    if (current?.status === "validated") continue;
    if (current && sameCalculation(current, c)) {
      unchanged += 1;
      continue;
    }
    if (current) {
      await cancel(current.id, "Recalculé");
      replaced += 1;
    }
    const item = await trx
      .insertInto("pay_items")
      .values({
        centre_id: actor.centreId,
        instructor_id: instructorId,
        kind: "rule",
        rule_id: c.rule.id,
        rule_snapshot: JSON.stringify(c.rule),
        group_id: c.groupId,
        period_key: c.periodKey,
        period_start: c.periodStart,
        period_end: c.periodEnd,
        due_on: c.dueOn,
        label: c.label,
        base: c.base,
        rate_numerator: c.rate.numerator,
        rate_denominator: c.rate.denominator,
        amount: c.amount,
        details: JSON.stringify(c.details),
        calculated_by: actor.userId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    if (c.sessionIds.length) {
      await trx
        .insertInto("pay_item_sessions")
        .values(c.sessionIds.map((sessionId) => ({ item_id: item.id, session_id: sessionId, instructor_id: instructorId })))
        .execute();
    }
    created += 1;
  }
  for (const [key, item] of byKey) {
    if (item.status === "calculated" && !seen.has(key)) {
      await cancel(item.id, "Ne s'applique plus après recalcul");
      replaced += 1;
    }
  }
  await writeAudit(trx, {
    centreId: actor.centreId,
    userId: actor.userId,
    action: "pay_items.calculated",
    objectType: "instructor",
    objectId: instructorId,
    after: { ...range, created, unchanged, replaced, warnings: warnings.length },
  });
  return { created, unchanged, replaced, warnings };
}

/** Validates calculated items that have reached their due date (the session, the end of the month, the end of the group). */
export async function validateItems(trx: Trx, actor: Actor, itemIds: string[]): Promise<number> {
  const { today } = await centreClock(trx, actor.centreId);
  const items = await trx
    .selectFrom("pay_items")
    .select(["id", "instructor_id as instructorId", "group_id as groupId", "status", "due_on as dueOn", "amount", "label", "kind"])
    .where("centre_id", "=", actor.centreId)
    .where("id", "in", itemIds)
    .forUpdate()
    .execute();
  if (items.length !== new Set(itemIds).size) throw notFound("pay item");
  for (const item of items) {
    if (item.status !== "calculated") throw conflict("item_not_calculated", `${item.label} is not waiting for validation`);
    if (item.dueOn > today) throw unprocessable("item_not_due", `${item.label} can be validated from ${item.dueOn}`);
  }
  await trx.updateTable("pay_items").set({ status: "validated", validated_at: new Date(), validated_by: actor.userId }).where("id", "in", itemIds).execute();
  for (const item of items) {
    await recordFinancialEvents(trx, [
      {
        centreId: actor.centreId,
        type: "payroll_validated",
        amount: item.amount,
        userId: actor.userId,
        instructorId: item.instructorId,
        ...(await axesOf(trx, item.groupId)),
        payload: { itemId: item.id, kind: item.kind, label: item.label },
      },
    ]);
  }
  await writeAudit(trx, {
    centreId: actor.centreId,
    userId: actor.userId,
    action: "pay_items.validated",
    objectType: "pay_item",
    objectId: itemIds.join(","),
    after: items.map((i) => ({ id: i.id, label: i.label, amount: i.amount })),
  });
  return items.length;
}

/** Amounts already settled per item (valid settlements only). */
export async function settledAmounts(trx: Trx | Transaction<Database>, itemIds: string[]): Promise<Map<string, number>> {
  if (itemIds.length === 0) return new Map();
  const rows = await trx
    .selectFrom("pay_settlement_lines")
    .innerJoin("pay_settlements", "pay_settlements.id", "pay_settlement_lines.settlement_id")
    .select(["pay_settlement_lines.item_id as itemId", sql<number>`sum(pay_settlement_lines.amount)::bigint`.as("settled")])
    .where("pay_settlements.status", "=", "valid")
    .where("pay_settlement_lines.item_id", "in", itemIds)
    .groupBy("pay_settlement_lines.item_id")
    .execute();
  return new Map(rows.map((r) => [r.itemId, Number(r.settled)]));
}

/**
 * Cancels a calculated item, or a validated one that nothing has paid yet, with a reason. Its sessions become
 * payable again, so the item can be recalculated. A paid item is corrected with a bonus or a deduction instead.
 */
export async function cancelItem(trx: Trx, actor: Actor, itemId: string, reason: string): Promise<void> {
  const item = await trx
    .selectFrom("pay_items")
    .select(["id", "instructor_id as instructorId", "group_id as groupId", "status", "amount", "label", "kind"])
    .where("id", "=", itemId)
    .where("centre_id", "=", actor.centreId)
    .forUpdate()
    .executeTakeFirst();
  if (!item) throw notFound("pay item");
  await lockInstructor(trx, item.instructorId, actor.centreId);
  if (item.status === "cancelled") throw conflict("already_cancelled", "the item is already cancelled");
  if (item.status === "validated" && ((await settledAmounts(trx, [item.id])).get(item.id) ?? 0) !== 0) {
    throw conflict("item_settled", "a paid item is corrected with a bonus or a deduction");
  }
  await trx
    .updateTable("pay_items")
    .set({ status: "cancelled", cancelled_at: new Date(), cancelled_by: actor.userId, cancel_reason: reason })
    .where("id", "=", itemId)
    .execute();
  await trx.updateTable("pay_item_sessions").set({ active: false }).where("item_id", "=", itemId).execute();
  if (item.status === "validated") {
    await recordFinancialEvents(trx, [
      {
        centreId: actor.centreId,
        type: "payroll_cancelled",
        amount: -item.amount,
        userId: actor.userId,
        instructorId: item.instructorId,
        ...(await axesOf(trx, item.groupId)),
        payload: { itemId: item.id, reason },
      },
    ]);
  }
  await writeAudit(trx, {
    centreId: actor.centreId,
    userId: actor.userId,
    action: "pay_item.cancelled",
    objectType: "pay_item",
    objectId: itemId,
    before: { status: item.status, amount: item.amount, label: item.label },
    reason,
  });
}

/** A bonus or a deduction, attached to a month for the summary; it is validated and settled like any other item. */
export async function addAdjustment(
  trx: Trx,
  actor: Actor,
  input: { instructorId: string; kind: "bonus" | "deduction"; amount: number; reason: string; month: string },
): Promise<string> {
  await lockInstructor(trx, input.instructorId, actor.centreId);
  const { today } = await centreClock(trx, actor.centreId);
  const { start, end } = monthBounds(input.month);
  const id = randomUUID();
  await trx
    .insertInto("pay_items")
    .values({
      id,
      centre_id: actor.centreId,
      instructor_id: input.instructorId,
      kind: input.kind,
      rule_id: null,
      rule_snapshot: null,
      group_id: null,
      period_key: `adjustment:${id}`,
      period_start: start,
      period_end: end,
      due_on: today < start ? today : start,
      label: `${input.kind === "bonus" ? "Prime" : "Retenue"} : ${input.reason}`,
      amount: input.kind === "bonus" ? input.amount : -input.amount,
      details: JSON.stringify({}),
      reason: input.reason,
      calculated_by: actor.userId,
    })
    .execute();
  await writeAudit(trx, {
    centreId: actor.centreId,
    userId: actor.userId,
    action: `pay_item.${input.kind}`,
    objectType: "pay_item",
    objectId: id,
    after: input,
    reason: input.reason,
  });
  return id;
}

async function nextSettlementNumber(trx: Trx, centreId: string, year: number): Promise<string> {
  const row = await sql<{ last_number: number }>`
    insert into pay_settlement_counters (centre_id, year, last_number) values (${centreId}, ${year}, 1)
    on conflict (centre_id, year) do update set last_number = pay_settlement_counters.last_number + 1
    returning last_number`.execute(trx);
  return `REG-${year}-${String(row.rows[0]!.last_number).padStart(6, "0")}`;
}

export interface SettlementInput {
  instructorId: string;
  paidOn: string;
  method: "cash" | "transfer" | "cheque";
  reference?: string | undefined;
  lines: { itemId: string; amount: number }[];
}

/**
 * Pays one or more validated items of one instructor, each in full or in part (a deduction is always taken in
 * full). The numbered proof of payment lists, for each item, what was due, already paid, paid now and left.
 */
export async function settleItems(trx: Trx, actor: Actor, input: SettlementInput): Promise<{ id: string; number: string; amount: number }> {
  const instructor = await lockInstructor(trx, input.instructorId, actor.centreId);
  const ids = input.lines.map((l) => l.itemId);
  if (new Set(ids).size !== ids.length) throw unprocessable("duplicate_item", "an item appears twice in the settlement");
  const items = await trx
    .selectFrom("pay_items")
    .select([
      "id",
      "instructor_id as instructorId",
      "group_id as groupId",
      "status",
      "amount",
      "label",
      "kind",
      "period_start as periodStart",
      "period_end as periodEnd",
    ])
    .where("centre_id", "=", actor.centreId)
    .where("id", "in", ids)
    .execute();
  if (items.length !== ids.length) throw notFound("pay item");
  const settled = await settledAmounts(trx, ids);
  const rows = input.lines.map((line) => {
    const item = items.find((i) => i.id === line.itemId)!;
    if (item.instructorId !== input.instructorId) throw unprocessable("other_instructor", `${item.label} belongs to another instructor`);
    if (item.status !== "validated") throw conflict("item_not_validated", `${item.label} must be validated before it is paid`);
    const already = settled.get(item.id) ?? 0;
    const remaining = item.amount - already;
    if (remaining === 0) throw conflict("already_paid", `${item.label} is already paid`);
    if (item.amount < 0 && line.amount !== remaining) throw unprocessable("deduction_in_full", `${item.label} is deducted in full`);
    if (item.amount > 0 && (line.amount <= 0 || line.amount > remaining))
      throw unprocessable("amount_above_remaining", `${item.label}: at most ${remaining} millimes remain`);
    return { item, already, paid: line.amount, remainingAfter: remaining - line.amount };
  });
  const total = rows.reduce((s, r) => s + r.paid, 0);
  if (total <= 0) throw unprocessable("nothing_to_pay", "the settlement must pay a positive amount");

  const { timezone } = await centreClock(trx, actor.centreId);
  const centre = await trx.selectFrom("centres").select(["name", "address"]).where("id", "=", actor.centreId).executeTakeFirstOrThrow();
  const issued = await sql<{ at: string }>`select to_char(now() at time zone ${timezone}, 'DD/MM/YYYY') as at`.execute(trx);
  const number = await nextSettlementNumber(trx, actor.centreId, Number(input.paidOn.slice(0, 4)));
  const pdf = await renderSettlement({
    centreName: centre.name,
    centreAddress: centre.address,
    number,
    instructorName: `${instructor.firstName} ${instructor.lastName}`,
    employment: EMPLOYMENT_FR[instructor.employment],
    paidOn: input.paidOn.split("-").reverse().join("/"),
    method: input.method,
    reference: input.reference ?? null,
    lines: rows.map((r) => ({
      label: r.item.label,
      period:
        r.item.periodStart === r.item.periodEnd
          ? r.item.periodStart.split("-").reverse().join("/")
          : `${r.item.periodStart.split("-").reverse().join("/")} au ${r.item.periodEnd.split("-").reverse().join("/")}`,
      due: r.item.amount,
      already: r.already,
      paid: r.paid,
      remaining: r.remainingAfter,
    })),
    total,
    issuedAt: issued.rows[0]!.at,
  });
  const settlement = await trx
    .insertInto("pay_settlements")
    .values({
      centre_id: actor.centreId,
      instructor_id: input.instructorId,
      number,
      paid_on: input.paidOn,
      method: input.method,
      reference: input.reference ?? null,
      amount: total,
      pdf,
      sha256: createHash("sha256").update(pdf).digest("hex"),
      created_by: actor.userId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await trx
    .insertInto("pay_settlement_lines")
    .values(rows.map((r) => ({ settlement_id: settlement.id, item_id: r.item.id, amount: r.paid })))
    .execute();
  await recordFinancialEvents(trx, [
    {
      centreId: actor.centreId,
      type: "payroll_paid",
      amount: total,
      userId: actor.userId,
      instructorId: input.instructorId,
      payload: {
        settlementId: settlement.id,
        number,
        method: input.method,
        paidOn: input.paidOn,
        items: rows.map((r) => ({ itemId: r.item.id, amount: r.paid })),
      },
    },
  ]);
  await writeAudit(trx, {
    centreId: actor.centreId,
    userId: actor.userId,
    action: "pay_settlement.created",
    objectType: "pay_settlement",
    objectId: settlement.id,
    after: { number, total, paidOn: input.paidOn, method: input.method, lines: input.lines },
  });
  return { id: settlement.id, number, amount: total };
}

/** Cancels a settlement entered by mistake: its items are owed again. The proof stays archived, marked cancelled. */
export async function cancelSettlement(trx: Trx, actor: Actor, settlementId: string, reason: string): Promise<void> {
  const settlement = await trx
    .selectFrom("pay_settlements")
    .select(["id", "instructor_id as instructorId", "status", "amount", "number"])
    .where("id", "=", settlementId)
    .where("centre_id", "=", actor.centreId)
    .forUpdate()
    .executeTakeFirst();
  if (!settlement) throw notFound("settlement");
  await lockInstructor(trx, settlement.instructorId, actor.centreId);
  if (settlement.status === "cancelled") throw conflict("already_cancelled", "the settlement is already cancelled");
  await trx
    .updateTable("pay_settlements")
    .set({ status: "cancelled", cancelled_at: new Date(), cancelled_by: actor.userId, cancel_reason: reason })
    .where("id", "=", settlementId)
    .execute();
  await recordFinancialEvents(trx, [
    {
      centreId: actor.centreId,
      type: "payroll_payment_cancelled",
      amount: -settlement.amount,
      userId: actor.userId,
      instructorId: settlement.instructorId,
      payload: { settlementId, number: settlement.number, reason },
    },
  ]);
  await writeAudit(trx, {
    centreId: actor.centreId,
    userId: actor.userId,
    action: "pay_settlement.cancelled",
    objectType: "pay_settlement",
    objectId: settlementId,
    reason,
  });
}
