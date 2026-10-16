import { addDays, isoWeekday, mulDivRound } from "@gcf/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { can } from "../auth/permissions.js";
import { groupAttendance } from "../domain/attendance.js";
import { centreClock, stateOf } from "../domain/ledger.js";
import { openMinutes } from "../domain/reports.js";
import { forbidden } from "../errors.js";

const query = z.object({ granularity: z.enum(["day", "week", "month"]).default("day") });
const BUCKETS = { day: 14, week: 12, month: 12 } as const;

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;

  app.get("/", async (request) => {
    const user = request.user;
    if (!user) throw forbidden();
    const financial = can(user, "dashboard:financial") || user.role === "admin";
    const operational = can(user, "dashboard:operational") || user.role === "admin";
    if (!financial && !operational) throw forbidden();
    const { granularity } = query.parse(request.query);
    const centreId = user.centreId;
    const { today, graceDays, timezone } = await centreClock(db, centreId);
    const monthStart = `${today.slice(0, 7)}-01`;
    const receivedDay = sql<string>`(payments.received_at at time zone ${timezone})::date`;
    const validPayment = sql<boolean>`payments.status = 'valid' and coalesce(payments.cheque_status, 'cashed') <> 'bounced'`;

    const result: Record<string, unknown> = { today, sections: { financial, operational } };

    const openCharges = await db
      .selectFrom("installments")
      .leftJoin("enrolments", "enrolments.id", "installments.enrolment_id")
      .leftJoin("rentals", "rentals.id", "installments.rental_id")
      .leftJoin(
        db
          .selectFrom("effective_allocations")
          .select(["installment_id", sql<number>`sum(amount)::bigint`.as("paid")])
          .groupBy("installment_id")
          .as("p"),
        "p.installment_id",
        "installments.id",
      )
      .select([
        "installments.amount",
        "installments.due_date as dueDate",
        "installments.original_due_date as originalDueDate",
        "installments.postponement_count as postponementCount",
        "installments.label",
        sql<string | null>`coalesce(enrolments.student_id::text, rentals.renter_id::text)`.as("payerId"),
        sql<number>`coalesce(p.paid, 0)`.as("paid"),
      ])
      .where("installments.centre_id", "=", centreId)
      .where("installments.kind", "=", "charge")
      .where("installments.status", "=", "open")
      .where(sql<boolean>`installments.amount > coalesce(p.paid, 0)`)
      .execute();
    const states = openCharges.map((c) => {
      const paid = Number(c.paid);
      return {
        ...c,
        remaining: c.amount - paid,
        state: stateOf(
          {
            kind: "charge",
            dueDate: c.dueDate,
            postponementCount: c.postponementCount,
            discountStatus: null,
            status: "open",
            paid,
            remaining: c.amount - paid,
          },
          today,
          graceDays,
        ),
      };
    });
    const overdue = states.filter((s) => s.state === "overdue");

    if (financial) {
      const sumBetween = async (from: string, to: string) =>
        Number(
          (
            await db
              .selectFrom("payments")
              .select(sql<number>`coalesce(sum(amount), 0)::bigint`.as("t"))
              .where("centre_id", "=", centreId)
              .where(validPayment)
              .where(receivedDay, ">=", from)
              .where(receivedDay, "<=", to)
              .executeTakeFirstOrThrow()
          ).t,
        );
      const unit = granularity;
      const series = await sql<{ bucket: string; total: number }>`
        with buckets as (
          select generate_series(date_trunc(${unit}, ${today}::date) - (${BUCKETS[granularity] - 1} || ' ' || ${unit})::interval, date_trunc(${unit}, ${today}::date), ('1 ' || ${unit})::interval)::date as bucket
        )
        select to_char(b.bucket, 'YYYY-MM-DD') as bucket, coalesce(sum(p.amount), 0)::bigint as total
        from buckets b
        left join payments p on p.centre_id = ${centreId}
          and p.status = 'valid' and coalesce(p.cheque_status, 'cashed') <> 'bounced'
          and date_trunc(${unit}, (p.received_at at time zone ${timezone})::date)::date = b.bucket
        group by b.bucket order by b.bucket`.execute(db);
      const payrollRow = await db
        .selectFrom("pay_items")
        .leftJoin(
          db
            .selectFrom("pay_settlement_lines")
            .innerJoin("pay_settlements", "pay_settlements.id", "pay_settlement_lines.settlement_id")
            .select(["pay_settlement_lines.item_id", sql<number>`sum(pay_settlement_lines.amount)::bigint`.as("paid")])
            .where("pay_settlements.status", "=", "valid")
            .groupBy("pay_settlement_lines.item_id")
            .as("s"),
          "s.item_id",
          "pay_items.id",
        )
        .select([
          sql<number>`coalesce(sum(pay_items.amount) filter (where pay_items.status = 'calculated'), 0)::bigint`.as("toValidate"),
          sql<number>`coalesce(sum(pay_items.amount - coalesce(s.paid, 0)) filter (where pay_items.status = 'validated'), 0)::bigint`.as("toPay"),
        ])
        .where("pay_items.centre_id", "=", centreId)
        .executeTakeFirstOrThrow();
      const payroll = { toValidate: Number(payrollRow.toValidate), toPay: Number(payrollRow.toPay) };
      result.financial = {
        collectionsToday: await sumBetween(today, today),
        collectionsMonth: await sumBetween(monthStart, today),
        unpaidTotal: overdue.reduce((s, o) => s + o.remaining, 0),
        unpaidPayers: new Set(overdue.map((o) => o.payerId)).size,
        postponedInstallments: states.filter((s) => s.postponementCount > 0).length,
        payroll,
        series: series.rows.map((r) => ({ bucket: r.bucket, total: Number(r.total) })),
      };
    }

    if (operational) {
      const groups = await db.selectFrom("groups").select("id").where("centre_id", "=", centreId).where("status", "=", "active").execute();
      let numerator = 0;
      let denominator = 0;
      for (const g of groups) {
        const r = await groupAttendance(db, g.id, centreId, monthStart, today);
        numerator += r.groupRate.numerator;
        denominator += r.groupRate.denominator;
      }
      const weekStart = addDays(today, 1 - isoWeekday(today));
      const weekEnd = addDays(weekStart, 6);
      const booked = await db
        .selectFrom("room_bookings")
        .select(sql<number>`coalesce(sum(extract(epoch from upper(period) - lower(period)) / 60), 0)::bigint`.as("minutes"))
        .where("centre_id", "=", centreId)
        .where("active", "=", true)
        .where(sql<string>`(lower(period) at time zone ${timezone})::date`, ">=", weekStart)
        .where(sql<string>`(lower(period) at time zone ${timezone})::date`, "<=", weekEnd)
        .executeTakeFirstOrThrow();
      const roomCount = Number(
        (
          await db
            .selectFrom("rooms")
            .select(sql<number>`count(*)::integer`.as("n"))
            .where("centre_id", "=", centreId)
            .where("status", "=", "active")
            .executeTakeFirstOrThrow()
        ).n,
      );
      const capacity = (await openMinutes(db, centreId, { from: weekStart, to: weekEnd })) * roomCount;

      const sessionDay = sql<string>`(class_sessions.starts_at at time zone ${timezone})::date`;
      const missingSheets = await db
        .selectFrom("class_sessions")
        .innerJoin("groups", "groups.id", "class_sessions.group_id")
        .select(["class_sessions.id", "groups.name as groupName", "class_sessions.starts_at as startsAt"])
        .where("class_sessions.centre_id", "=", centreId)
        .where("class_sessions.status", "!=", "cancelled")
        .where("class_sessions.sheet_status", "!=", "validated")
        .where("class_sessions.starts_at", "<=", new Date())
        .where(sessionDay, ">=", addDays(today, -7))
        .orderBy("class_sessions.starts_at")
        .execute();
      const remindedRecently = await db
        .selectFrom("mail_dispatches")
        .select("student_id")
        .where("centre_id", "=", centreId)
        .where("kind", "=", "reminder")
        .where("status", "=", "sent")
        .where("sent_at", ">=", new Date(Date.now() - 7 * 86_400_000))
        .execute();
      const reminded = new Set(remindedRecently.map((r) => r.student_id));
      const unclosedDays = await db
        .selectFrom("payments")
        .select(sql<string>`to_char((payments.received_at at time zone ${timezone})::date, 'YYYY-MM-DD')`.as("day"))
        .where("payments.centre_id", "=", centreId)
        .where(receivedDay, "<", today)
        .where(receivedDay, ">=", addDays(today, -30))
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom("cash_closings")
                .select("id")
                .where("cash_closings.centre_id", "=", centreId)
                .whereRef(sql`cash_closings.day`, "=", receivedDay),
            ),
          ),
        )
        .distinct()
        .execute();
      const agenda = await db
        .selectFrom("class_sessions")
        .innerJoin("groups", "groups.id", "class_sessions.group_id")
        .innerJoin("instructors", "instructors.id", "class_sessions.instructor_id")
        .leftJoin("rooms", "rooms.id", "class_sessions.room_id")
        .select([
          "class_sessions.id",
          "class_sessions.starts_at as startsAt",
          "class_sessions.ends_at as endsAt",
          "groups.name as label",
          sql<string>`instructors.first_name || ' ' || instructors.last_name`.as("instructorName"),
          "rooms.name as roomName",
          "class_sessions.sheet_status as sheetStatus",
        ])
        .where("class_sessions.centre_id", "=", centreId)
        .where("class_sessions.status", "!=", "cancelled")
        .where(sessionDay, "=", today)
        .execute();
      const rentalsToday = await db
        .selectFrom("rental_slots")
        .innerJoin("rentals", "rentals.id", "rental_slots.rental_id")
        .innerJoin("renters", "renters.id", "rentals.renter_id")
        .innerJoin("rooms", "rooms.id", "rentals.room_id")
        .select(["rental_slots.id", "rental_slots.starts_at as startsAt", "rental_slots.ends_at as endsAt", "renters.name as label", "rooms.name as roomName"])
        .where("rentals.centre_id", "=", centreId)
        .where("rentals.status", "=", "active")
        .where(sql<string>`(rental_slots.starts_at at time zone ${timezone})::date`, "=", today)
        .execute();
      result.operational = {
        attendanceRateBasisPoints: denominator > 0 ? mulDivRound(10_000, numerator, denominator) : null,
        roomOccupancyBasisPoints: capacity > 0 ? mulDivRound(10_000, Number(booked.minutes), capacity) : null,
        todo: {
          sessionsWithoutSheet: missingSheets,
          overdueInstallments: { count: overdue.length, total: overdue.reduce((s, o) => s + o.remaining, 0) },
          remindersToSend: new Set(overdue.map((o) => o.payerId).filter((id) => id !== null && !reminded.has(id))).size,
          unclosedCashDays: unclosedDays.map((d) => d.day).sort(),
        },
        agenda: [
          ...agenda.map((a) => ({ type: "session" as const, ...a })),
          ...rentalsToday.map((r) => ({ type: "rental" as const, instructorName: null, sheetStatus: null, ...r })),
        ].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()),
      };
    }
    return result;
  });
};
