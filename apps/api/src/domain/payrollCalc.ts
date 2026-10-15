import { addDays, attendanceRate, computePay, mulDivRound, PayrollError, rateToBasisPoints, type AttendanceStatus, type PayRule, type Rate } from "@gcf/shared";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database, PayRulesTable } from "../db/types.js";
import type { Selectable } from "kysely";

type Db = Kysely<Database> | Transaction<Database>;
export type PayRuleRow = Selectable<PayRulesTable>;

const SPECIFICITY: Record<PayRuleRow["scope"], number> = { group: 3, study: 2, training: 2, instructor: 1 };

export function monthBounds(month: string): { start: string; end: string } {
  const start = `${month.slice(0, 7)}-01`;
  const [y, m] = [Number(start.slice(0, 4)), Number(start.slice(5, 7))];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { start, end: addDays(next, -1) };
}

/** Rule priority: group, then study or training, then the instructor's default; the most recent wins a tie. */
export function pickRule(rules: PayRuleRow[], instructorId: string, group: { id: string; studyId: string | null; trainingId: string | null }): PayRuleRow | undefined {
  return rules
    .filter(
      (r) =>
        r.instructor_id === instructorId &&
        ((r.scope === "group" && r.group_id === group.id) ||
          (r.scope === "study" && r.study_id !== null && r.study_id === group.studyId) ||
          (r.scope === "training" && r.training_id !== null && r.training_id === group.trainingId) ||
          r.scope === "instructor"),
    )
    .sort((a, b) => SPECIFICITY[b.scope] - SPECIFICITY[a.scope] || b.valid_from.localeCompare(a.valid_from))[0];
}

export function toPayRule(rule: PayRuleRow, inputs: { collected: number; sessions: number; minutes: number }): PayRule {
  const base = (() => {
    switch (rule.base_kind) {
      case "pct_collections":
        return { kind: "pct_collections" as const, basisPoints: rule.basis_points!, collected: inputs.collected };
      case "pct_session_tariff":
        return { kind: "pct_session_tariff" as const, basisPoints: rule.basis_points!, sessionTariff: rule.amount!, sessionsHeld: inputs.sessions };
      case "fixed_per_session":
        return { kind: "fixed_per_session" as const, amountPerSession: rule.amount!, sessionsHeld: inputs.sessions };
      case "monthly_flat":
        return { kind: "monthly_flat" as const, amount: rule.amount! };
      case "hourly":
        return { kind: "hourly" as const, hourlyRate: rule.amount!, minutesDelivered: inputs.minutes };
      case "training_flat":
        return { kind: "training_flat" as const, amount: rule.amount! };
    }
  })();
  const presence =
    rule.presence_kind === "threshold"
      ? { kind: "threshold" as const, minRateBasisPoints: rule.min_rate_basis_points!, prorataAbove: rule.prorata_above!, ...(rule.floor_amount === null ? {} : { floor: rule.floor_amount }) }
      : { kind: rule.presence_kind };
  return { base, presence };
}

export interface ComputedLine {
  instructorId: string;
  groupId: string | null;
  rule: PayRuleRow;
  base: number;
  rate: Rate;
  amount: number;
  details: Record<string, unknown>;
}

export interface CalculationWarning {
  instructorId: string;
  groupId: string | null;
  code: "no_rule" | "no_attendance";
  message: string;
}

interface HeldSession {
  id: string;
  groupId: string;
  instructorId: string;
  minutes: number;
  studyId: string | null;
  trainingId: string | null;
  groupEnd: string;
}

/**
 * Computes the pay lines of a month from validated sessions only (cancelled sessions are never paid).
 * Collections of a group are shared between its instructors in proportion to the sessions each held.
 */
export async function computeMonth(db: Db, centreId: string, month: string): Promise<{ lines: ComputedLine[]; warnings: CalculationWarning[] }> {
  const { start, end } = monthBounds(month);
  const centre = await db.selectFrom("centres").select(["timezone", "count_justified_as_present", "count_makeup_as_present"]).where("id", "=", centreId).executeTakeFirstOrThrow();
  const localDate = sql<string>`(class_sessions.starts_at at time zone ${centre.timezone})::date`;
  const sessions: HeldSession[] = (
    await db
      .selectFrom("class_sessions")
      .innerJoin("groups", "groups.id", "class_sessions.group_id")
      .leftJoin("training_sessions", "training_sessions.id", "groups.training_session_id")
      .select([
        "class_sessions.id",
        "class_sessions.group_id as groupId",
        "class_sessions.instructor_id as instructorId",
        sql<number>`(extract(epoch from class_sessions.ends_at - class_sessions.starts_at) / 60)::integer`.as("minutes"),
        "groups.study_id as studyId",
        "training_sessions.training_id as trainingId",
        "groups.end_date as groupEnd",
      ])
      .where("class_sessions.centre_id", "=", centreId)
      .where("class_sessions.status", "=", "held")
      .where("class_sessions.sheet_status", "=", "validated")
      .where(localDate, ">=", start)
      .where(localDate, "<=", end)
      .execute()
  ).map((s) => ({ ...s, minutes: Number(s.minutes) }));

  const rules = await db
    .selectFrom("pay_rules")
    .selectAll()
    .where("centre_id", "=", centreId)
    .where("status", "=", "active")
    .where("valid_from", "<=", end)
    .where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">=", start)]))
    .execute();

  const groups = new Map<string, { id: string; studyId: string | null; trainingId: string | null; groupEnd: string }>();
  for (const s of sessions) groups.set(s.groupId, { id: s.groupId, studyId: s.studyId, trainingId: s.trainingId, groupEnd: s.groupEnd });

  const groupSettings = new Map<string, { countJustifiedAsPresent: boolean; countOtherGroupAsPresent: boolean }>();
  if (groups.size) {
    const rows = await db.selectFrom("groups").select(["id", "count_justified_override", "count_makeup_override"]).where("id", "in", [...groups.keys()]).execute();
    for (const r of rows) {
      groupSettings.set(r.id, {
        countJustifiedAsPresent: r.count_justified_override ?? centre.count_justified_as_present,
        countOtherGroupAsPresent: r.count_makeup_override ?? centre.count_makeup_as_present,
      });
    }
  }
  const records = sessions.length
    ? await db.selectFrom("attendance_records").select(["session_id as sessionId", "status"]).where("session_id", "in", sessions.map((s) => s.id)).where("is_guest", "=", false).execute()
    : [];
  const statusesBySession = new Map<string, AttendanceStatus[]>();
  for (const r of records) statusesBySession.set(r.sessionId, [...(statusesBySession.get(r.sessionId) ?? []), r.status]);

  const rateFor = (sessionIds: string[], settings: { countJustifiedAsPresent: boolean; countOtherGroupAsPresent: boolean }) =>
    attendanceRate(sessionIds.flatMap((id) => statusesBySession.get(id) ?? []), settings);

  const collectedByGroup = async (groupId: string, basis: "collected" | "invoiced"): Promise<number> => {
    if (basis === "collected") {
      const row = await db
        .selectFrom("effective_allocations")
        .innerJoin("payments", "payments.id", "effective_allocations.payment_id")
        .innerJoin("installments", "installments.id", "effective_allocations.installment_id")
        .innerJoin("enrolments", "enrolments.id", "installments.enrolment_id")
        .select(sql<number>`coalesce(sum(effective_allocations.amount), 0)::bigint`.as("total"))
        .where("enrolments.group_id", "=", groupId)
        .where(sql<string>`(payments.received_at at time zone ${centre.timezone})::date`, ">=", start)
        .where(sql<string>`(payments.received_at at time zone ${centre.timezone})::date`, "<=", end)
        .executeTakeFirstOrThrow();
      return Number(row.total);
    }
    const row = await db
      .selectFrom("installments")
      .innerJoin("enrolments", "enrolments.id", "installments.enrolment_id")
      .select(sql<number>`coalesce(sum(installments.amount), 0)::bigint`.as("total"))
      .where("enrolments.group_id", "=", groupId)
      .where("installments.status", "=", "open")
      .where((eb) => eb.or([eb("installments.kind", "=", "charge"), eb("installments.discount_status", "=", "approved")]))
      .where("installments.due_date", ">=", start)
      .where("installments.due_date", "<=", end)
      .executeTakeFirstOrThrow();
    return Number(row.total);
  };

  const lines: ComputedLine[] = [];
  const warnings: CalculationWarning[] = [];

  const build = (instructorId: string, groupId: string | null, rule: PayRuleRow, rate: Rate, inputs: { collected: number; sessions: number; minutes: number }, extra: Record<string, unknown>) => {
    try {
      const result = computePay(toPayRule(rule, inputs), rate);
      lines.push({ instructorId, groupId, rule, base: result.base, rate: result.factor, amount: result.amount, details: { ...inputs, ...extra, rateBasisPoints: rateToBasisPoints(rate) ?? null } });
    } catch (error) {
      if (!(error instanceof PayrollError)) throw error;
      warnings.push({ instructorId, groupId, code: "no_attendance", message: error.message });
      lines.push({ instructorId, groupId, rule, base: 0, rate: { numerator: 0, denominator: 1 }, amount: 0, details: { ...inputs, ...extra, error: error.message } });
    }
  };

  // Monthly flat rules set on the instructor: one line per month, attendance over all their sessions.
  const instructorFlats = rules.filter((r) => r.scope === "instructor" && r.base_kind === "monthly_flat");
  const flatInstructors = new Set<string>();
  for (const rule of instructorFlats.sort((a, b) => b.valid_from.localeCompare(a.valid_from))) {
    if (flatInstructors.has(rule.instructor_id)) continue;
    flatInstructors.add(rule.instructor_id);
    const own = sessions.filter((s) => s.instructorId === rule.instructor_id);
    const settings = { countJustifiedAsPresent: centre.count_justified_as_present, countOtherGroupAsPresent: centre.count_makeup_as_present };
    const rate = rule.presence_kind === "ignore" || rule.presence_kind === "session_due" ? { numerator: 1, denominator: 1 } : rateFor(own.map((s) => s.id), settings);
    build(rule.instructor_id, null, rule, rate, { collected: 0, sessions: own.length, minutes: own.reduce((t, s) => t + s.minutes, 0) }, { scope: "instructor" });
  }

  const pairs = new Map<string, HeldSession[]>();
  for (const s of sessions) pairs.set(`${s.instructorId}|${s.groupId}`, [...(pairs.get(`${s.instructorId}|${s.groupId}`) ?? []), s]);
  for (const [key, own] of pairs) {
    const [instructorId, groupId] = key.split("|") as [string, string];
    const group = groups.get(groupId)!;
    const rule = pickRule(rules, instructorId, group);
    if (!rule) {
      warnings.push({ instructorId, groupId, code: "no_rule", message: "no pay rule applies to this instructor for this group" });
      continue;
    }
    if (rule.scope === "instructor" && rule.base_kind === "monthly_flat") continue;
    if (rule.base_kind === "training_flat" && !(group.groupEnd >= start && group.groupEnd <= end)) continue;
    const settings = groupSettings.get(groupId)!;
    const rate = rateFor(own.map((s) => s.id), settings);
    let collected = 0;
    let share: { mine: number; total: number } | null = null;
    if (rule.base_kind === "pct_collections") {
      const total = sessions.filter((s) => s.groupId === groupId).length;
      const groupTotal = await collectedByGroup(groupId, rule.collection_basis ?? "collected");
      collected = mulDivRound(groupTotal, own.length, total);
      share = { mine: own.length, total };
    }
    build(instructorId, groupId, rule, rate, { collected, sessions: own.length, minutes: own.reduce((t, s) => t + s.minutes, 0) }, { scope: rule.scope, share });
  }
  return { lines, warnings };
}
