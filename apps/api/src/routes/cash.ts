import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { cashDay } from "../domain/cash.js";
import { recordFinancialEvents } from "../domain/financialEvents.js";
import { centreClock } from "../domain/ledger.js";
import { conflict, unprocessable } from "../errors.js";
import { isoDate, millimes } from "../validation.js";

const dayQuery = z.object({ date: isoDate });
const closeBody = z.object({ day: isoDate, countedCash: millimes, comment: z.string().trim().max(1000).optional() }).strict();

export const cashRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;

  app.get("/journal", { preHandler: app.requirePermission("cash:read") }, async (request) => {
    const centreId = request.user!.centreId;
    const { date } = dayQuery.parse(request.query);
    const day = await cashDay(db, centreId, date);
    const closing = await db
      .selectFrom("cash_closings")
      .leftJoin("users", "users.id", "cash_closings.closed_by")
      .select(["cash_closings.expected_cash as expectedCash", "cash_closings.counted_cash as countedCash", "cash_closings.difference", "cash_closings.comment", "cash_closings.closed_at as closedAt", "users.full_name as closedBy"])
      .where("cash_closings.centre_id", "=", centreId)
      .where("cash_closings.day", "=", date)
      .executeTakeFirst();
    return { ...day, closing: closing ?? null };
  });

  /** Locks the day: expected cash is recomputed on the server, a difference needs a comment. */
  app.post("/closings", { preHandler: app.requirePermission("cash:close") }, async (request, reply) => {
    const actor = request.user!;
    const body = closeBody.parse(request.body);
    const result = await db.transaction().execute(async (trx) => {
      const { today } = await centreClock(trx, actor.centreId);
      if (body.day > today) throw unprocessable("future_day", "a day can only be closed once it has started");
      const existing = await trx.selectFrom("cash_closings").select("id").where("centre_id", "=", actor.centreId).where("day", "=", body.day).executeTakeFirst();
      if (existing) throw conflict("already_closed", "this day is already closed");
      const day = await cashDay(trx, actor.centreId, body.day);
      const difference = body.countedCash - day.expectedCash;
      if (difference !== 0 && !body.comment) throw unprocessable("comment_required", "explain the difference between expected and counted cash");
      const closing = await trx
        .insertInto("cash_closings")
        .values({ centre_id: actor.centreId, day: body.day, expected_cash: day.expectedCash, counted_cash: body.countedCash, difference, comment: body.comment ?? null, totals: JSON.stringify(day.totals), closed_by: actor.userId })
        .returning(["id", "day", "expected_cash as expectedCash", "counted_cash as countedCash", "difference", "comment"])
        .executeTakeFirstOrThrow();
      await recordFinancialEvents(trx, [{ centreId: actor.centreId, type: "cash_closed", amount: difference, userId: actor.userId, payload: { day: body.day, expected: day.expectedCash, counted: body.countedCash, totals: day.totals } }]);
      await writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action: "cash.closed", objectType: "cash_closing", objectId: closing.id, after: closing, reason: body.comment ?? null });
      return closing;
    });
    return reply.status(201).send(result);
  });

  app.get("/closings", { preHandler: app.requirePermission("cash:read") }, async (request) =>
    db
      .selectFrom("cash_closings")
      .leftJoin("users", "users.id", "cash_closings.closed_by")
      .select(["cash_closings.id", "cash_closings.day", "cash_closings.expected_cash as expectedCash", "cash_closings.counted_cash as countedCash", "cash_closings.difference", "cash_closings.comment", "cash_closings.closed_at as closedAt", "users.full_name as closedBy"])
      .where("cash_closings.centre_id", "=", request.user!.centreId)
      .orderBy("cash_closings.day", "desc")
      .limit(120)
      .execute(),
  );
};
