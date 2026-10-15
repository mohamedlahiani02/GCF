import { addDays, attendanceRate, computePay, mulDivRound, PayrollError, rateToBasisPoints, type AttendanceStatus, type PayRule, type Rate } from "@gcf/shared";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { Database, PayRulesTable } from "../db/types.js";

type Db = Kysely<Database> | Transaction<Database>;
export type PayRuleRow = Selectable<PayRulesTable>;

const SPECIFICITY: Record<PayRuleRow["scope"], number> = { group: 3, study: 2, training: 2, instructor: 1 };
const MONTHS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const frDate = (iso: string) => iso.split("-").reverse().join("/");
export const monthLabel = (month: string) => `${MONTHS_FR[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

export function monthBounds(month: string): { start: string; end: string } {
  const start = `${month.slice(0, 7)}-01`;
  const [y, m] = [Number(start.slice(0, 4)), Number(start.slice(5, 7))];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { start, end: addDays(next, -1) };
}

/**
 * The rule that pays a session: valid on the session date, most specific first (group, then private lesson or
 * training, then the instructor's default); the most recent rule wins a tie.
 */
export function pickRule(
  rules: PayRuleRow[],
  instructorId: string,
  group: { id: string; studyId: string | null; trainingId: string | null },
  date: string,
): PayRuleRow | undefined {
  return rules
    .filter(
      (r) =>
        r.instructor_id === instructorId &&
        r.valid_from <= date &&
        (r.valid_to === null || r.valid_to >= date) &&
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
      ? {
          kind: "threshold" as const,
          minRateBasisPoints: rule.min_rate_basis_points!,
          prorataAbove: rule.prorata_above!,
          ...(rule.floor_amount === null ? {} : { floor: rule.floor_amount }),
        }
      : { kind: rule.presence_kind };
  return { base, presence };
}

/** A pay item the rules produce for one instructor, before it is stored. */
export interface PayCandidate {
  instructorId: string;
  rule: PayRuleRow;
  groupId: string | null;
  groupName: string | null;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  dueOn: string;
  label: string;
  sessionIds: string[];
  base: number;
  rate: Rate;
  amount: number;
  details: Record<string, unknown>;
}

export interface PayWarning {
  instructorId: string;
  groupId: string | null;
  groupName: string | null;
  code: "no_rule" | "no_attendance";
  message: string;
}

interface HeldSession {
  id: string;
  groupId: string;
  groupName: string;
  instructorId: string;
  localDate: string;
  minutes: number;
  studyId: string | null;
  trainingId: string | null;
  groupStart: string;
  groupEnd: string;
}

export interface CandidateScope {
  /** Items whose period ends in this range are produced. */
  from: string;
  to: string;
  instructorId?: string | undefined;
  groupId?: string | undefined;
  /** Sessions already paid by a validated item are left out, so nothing is ever paid twice. */
  excludeValidated: boolean;
}

/**
 * Pay items due in a range, from held sessions with a validated sheet only (a cancelled session is never paid).
 * Each session is paid by the one rule that applies on its date, at that rule's rhythm: one item per session, per
 * month, or per training group at its end. Collections of a group are shared between its instructors in proportion
 * to the sessions each held in the month.
 */
export async function computeCandidates(db: Db, centreId: string, scope: CandidateScope): Promise<{ candidates: PayCandidate[]; warnings: PayWarning[] }> {
  const centre = await db
    .selectFrom("centres")
    .select(["timezone", "count_justified_as_present", "count_makeup_as_present"])
    .where("id", "=", centreId)
    .executeTakeFirstOrThrow();
  const localDate = sql<string>`(class_sessions.starts_at at time zone ${centre.timezone})::date`;
  const heldSessions = (filter: (qb: ReturnType<typeof baseQuery>) => ReturnType<typeof baseQuery>) => filter(baseQuery()).execute();
  const baseQuery = () =>
    db
      .selectFrom("class_sessions")
      .innerJoin("groups", "groups.id", "class_sessions.group_id")
      .leftJoin("training_sessions", "training_sessions.id", "groups.training_session_id")
      .select([
        "class_sessions.id",
        "class_sessions.group_id as groupId",
        "groups.name as groupName",
        "class_sessions.instructor_id as instructorId",
        sql<string>`to_char(${localDate}, 'YYYY-MM-DD')`.as("localDate"),
        sql<number>`(extract(epoch from class_sessions.ends_at - class_sessions.starts_at) / 60)::integer`.as("minutes"),
        "groups.study_id as studyId",
        "training_sessions.training_id as trainingId",
        "groups.start_date as groupStart",
        "groups.end_date as groupEnd",
      ])
      .where("class_sessions.centre_id", "=", centreId)
      .where("class_sessions.status", "=", "held")
      .where("class_sessions.sheet_status", "=", "validated")
      .$if(scope.instructorId !== undefined, (qb) => qb.where("class_sessions.instructor_id", "=", scope.instructorId!))
      .$if(scope.groupId !== undefined, (qb) => qb.where("class_sessions.group_id", "=", scope.groupId!));

  // Sessions in the range, plus every session of the groups ending in the range (a training fee covers the whole group).
  const inRange = await heldSessions((qb) => qb.where(localDate, ">=", scope.from).where(localDate, "<=", scope.to));
  const ending = await heldSessions((qb) => qb.where("groups.end_date", ">=", scope.from).where("groups.end_date", "<=", scope.to));
  const sessionsById = new Map<string, HeldSession>();
  for (const s of [...inRange, ...ending]) sessionsById.set(s.id, { ...s, minutes: Number(s.minutes) });

  let paidSessions = new Set<string>();
  if (scope.excludeValidated && sessionsById.size) {
    const linked = await db
      .selectFrom("pay_item_sessions")
      .innerJoin("pay_items", "pay_items.id", "pay_item_sessions.item_id")
      .select(["pay_item_sessions.session_id as sessionId", "pay_item_sessions.instructor_id as instructorId"])
      .where("pay_item_sessions.active", "=", true)
      .where("pay_items.status", "=", "validated")
      .where("pay_item_sessions.session_id", "in", [...sessionsById.keys()])
      .execute();
    paidSessions = new Set(linked.map((l) => `${l.sessionId}|${l.instructorId}`));
  }
  const sessions = [...sessionsById.values()].filter((s) => !paidSessions.has(`${s.id}|${s.instructorId}`));

  const rules = await db
    .selectFrom("pay_rules")
    .selectAll()
    .where("centre_id", "=", centreId)
    .where("status", "=", "active")
    .$if(scope.instructorId !== undefined, (qb) => qb.where("instructor_id", "=", scope.instructorId!))
    .execute();

  const groupIds = [...new Set(sessions.map((s) => s.groupId))];
  const groupSettings = new Map<string, { countJustifiedAsPresent: boolean; countOtherGroupAsPresent: boolean }>();
  if (groupIds.length) {
    const rows = await db.selectFrom("groups").select(["id", "count_justified_override", "count_makeup_override"]).where("id", "in", groupIds).execute();
    for (const r of rows) {
      groupSettings.set(r.id, {
        countJustifiedAsPresent: r.count_justified_override ?? centre.count_justified_as_present,
        countOtherGroupAsPresent: r.count_makeup_override ?? centre.count_makeup_as_present,
      });
    }
  }
  const centreSettings = { countJustifiedAsPresent: centre.count_justified_as_present, countOtherGroupAsPresent: centre.count_makeup_as_present };
  const records = sessions.length
    ? await db
        .selectFrom("attendance_records")
        .select(["session_id as sessionId", "status"])
        .where(
          "session_id",
          "in",
          sessions.map((s) => s.id),
        )
        .where("is_guest", "=", false)
        .execute()
    : [];
  const statusesBySession = new Map<string, AttendanceStatus[]>();
  for (const r of records) statusesBySession.set(r.sessionId, [...(statusesBySession.get(r.sessionId) ?? []), r.status]);

  const collectedInMonth = async (groupId: string, month: string, basis: "collected" | "invoiced"): Promise<number> => {
    const { start, end } = monthBounds(month);
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
  const heldInMonth = async (groupId: string, month: string): Promise<number> => {
    const { start, end } = monthBounds(month);
    const row = await db
      .selectFrom("class_sessions")
      .select(sql<number>`count(*)::integer`.as("n"))
      .where("group_id", "=", groupId)
      .where("status", "=", "held")
      .where("sheet_status", "=", "validated")
      .where(localDate, ">=", start)
      .where(localDate, "<=", end)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  };

  interface Bucket {
    instructorId: string;
    rule: PayRuleRow;
    groupId: string | null;
    groupName: string | null;
    periodKey: string;
    periodStart: string;
    periodEnd: string;
    dueOn: string;
    label: string;
    month: string | null;
    sessions: HeldSession[];
  }
  const buckets = new Map<string, Bucket>();
  const warnings: PayWarning[] = [];
  const warned = new Set<string>();

  for (const s of sessions) {
    const rule = pickRule(rules, s.instructorId, { id: s.groupId, studyId: s.studyId, trainingId: s.trainingId }, s.localDate);
    if (!rule) {
      if (!warned.has(`${s.instructorId}|${s.groupId}`)) {
        warned.add(`${s.instructorId}|${s.groupId}`);
        warnings.push({
          instructorId: s.instructorId,
          groupId: s.groupId,
          groupName: s.groupName,
          code: "no_rule",
          message: "no pay rule applies to this instructor for this group",
        });
      }
      continue;
    }
    const month = s.localDate.slice(0, 7);
    const flatForInstructor = rule.base_kind === "monthly_flat" && rule.scope === "instructor";
    const shape =
      rule.periodicity === "session"
        ? { periodKey: `session:${s.id}`, periodStart: s.localDate, periodEnd: s.localDate, label: `${s.groupName}, séance du ${frDate(s.localDate)}`, month }
        : rule.periodicity === "training"
          ? {
              periodKey: `training:${s.groupId}`,
              periodStart: s.groupStart,
              periodEnd: s.groupEnd,
              label: `${s.groupName}, formation du ${frDate(s.groupStart)} au ${frDate(s.groupEnd)}`,
              month: null,
            }
          : {
              periodKey: `month:${month}`,
              periodStart: monthBounds(month).start,
              periodEnd: monthBounds(month).end,
              label: `${flatForInstructor ? "Forfait mensuel" : s.groupName}, ${monthLabel(month)}`,
              month,
            };
    const groupId = flatForInstructor ? null : s.groupId;
    const key = `${s.instructorId}|${rule.id}|${groupId ?? ""}|${shape.periodKey}`;
    const bucket = buckets.get(key) ?? {
      instructorId: s.instructorId,
      rule,
      groupId,
      groupName: flatForInstructor ? null : s.groupName,
      ...shape,
      dueOn: shape.periodEnd,
      sessions: [],
    };
    bucket.sessions.push(s);
    buckets.set(key, bucket);
  }

  // A monthly flat set on the instructor is owed every month it is in force, even without a session.
  for (const rule of rules.filter((r) => r.scope === "instructor" && r.base_kind === "monthly_flat")) {
    if (scope.groupId !== undefined) break;
    for (let month = scope.from.slice(0, 7); month <= scope.to.slice(0, 7); month = addDays(monthBounds(month).end, 1).slice(0, 7)) {
      const { start, end } = monthBounds(month);
      if (end < scope.from || end > scope.to) continue;
      if (rule.valid_from > end || (rule.valid_to !== null && rule.valid_to < start)) continue;
      const key = `${rule.instructor_id}|${rule.id}||month:${month}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          instructorId: rule.instructor_id,
          rule,
          groupId: null,
          groupName: null,
          periodKey: `month:${month}`,
          periodStart: start,
          periodEnd: end,
          dueOn: end,
          label: `Forfait mensuel, ${monthLabel(month)}`,
          month,
          sessions: [],
        });
      }
    }
  }

  const candidates: PayCandidate[] = [];
  for (const b of buckets.values()) {
    if (b.periodEnd < scope.from || b.periodEnd > scope.to) continue;
    const settings = b.groupId ? (groupSettings.get(b.groupId) ?? centreSettings) : centreSettings;
    const rate = attendanceRate(
      b.sessions.flatMap((s) => statusesBySession.get(s.id) ?? []),
      settings,
    );
    let collected = 0;
    let share: { mine: number; total: number } | null = null;
    if (b.rule.base_kind === "pct_collections" && b.groupId && b.month) {
      const total = await heldInMonth(b.groupId, b.month);
      const groupTotal = await collectedInMonth(b.groupId, b.month, b.rule.collection_basis ?? "collected");
      collected = total > 0 ? mulDivRound(groupTotal, b.sessions.length, total) : 0;
      share = { mine: b.sessions.length, total };
    }
    const inputs = { collected, sessions: b.sessions.length, minutes: b.sessions.reduce((t, s) => t + s.minutes, 0) };
    const common = {
      instructorId: b.instructorId,
      rule: b.rule,
      groupId: b.groupId,
      groupName: b.groupName,
      periodKey: b.periodKey,
      periodStart: b.periodStart,
      periodEnd: b.periodEnd,
      dueOn: b.dueOn,
      label: b.label,
      sessionIds: b.sessions.map((s) => s.id),
    };
    try {
      const result = computePay(toPayRule(b.rule, inputs), rate);
      candidates.push({
        ...common,
        base: result.base,
        rate: result.factor,
        amount: result.amount,
        details: { ...inputs, share, rateBasisPoints: rateToBasisPoints(rate) ?? null },
      });
    } catch (error) {
      if (!(error instanceof PayrollError)) throw error;
      warnings.push({ instructorId: b.instructorId, groupId: b.groupId, groupName: b.groupName, code: "no_attendance", message: error.message });
      candidates.push({
        ...common,
        base: 0,
        rate: { numerator: 0, denominator: 1 },
        amount: 0,
        details: { ...inputs, share, rateBasisPoints: null, error: error.message },
      });
    }
  }
  candidates.sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || a.label.localeCompare(b.label, "fr"));
  return { candidates, warnings };
}
