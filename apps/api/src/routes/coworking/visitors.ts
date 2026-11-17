import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import type { MailContext } from "../../domain/coworking/bookings.js";
import { announceVisitor, moveVisitor, visitorRows } from "../../domain/coworking/visitors.js";
import { notFound } from "../../errors.js";
import { clockTime, idParam, isoDate, optionalText, requiredText, uuid } from "../../validation.js";

export const visitorFields = {
  name: requiredText(120),
  company: optionalText(120),
  phone: optionalText(40),
  expectedOn: isoDate,
  expectedAt: clockTime.nullable().optional(),
  purpose: optionalText(200),
};
const staffBody = z.object({ ...visitorFields, hostMemberId: uuid }).strict();
const dayQuery = z.object({ date: isoDate, status: z.enum(["all", "expected", "arrived", "left", "cancelled"]).default("all") });
const stepParam = z.object({ id: uuid, step: z.enum(["arrive", "leave", "cancel"]) });

/** Visitor register at the front desk: guests of a day, arrivals, departures and walk-in guests (staff). */
export const coworkingVisitorRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app;
  const read = app.requirePermission("coworking:read");
  const write = app.requirePermission("coworking:write");
  const mail = (request: FastifyRequest): MailContext => ({ mailer: app.mailer, log: request.log, publicOrigin: config.publicOrigin });

  app.get("/visitors", { preHandler: read }, async (request) => {
    const { date, status } = dayQuery.parse(request.query);
    return visitorRows(db, request.user!.centreId)
      .where("v.expected_on", "=", date)
      .$if(status !== "all", (qb) => qb.where("v.status", "=", status as "expected"))
      .orderBy("v.expected_at")
      .orderBy("v.name")
      .execute();
  });

  app.post("/visitors", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const body = staffBody.parse(request.body);
    return reply.status(201).send(await announceVisitor(db, actor.centreId, { source: "staff", userId: actor.userId }, body));
  });

  app.post("/visitors/:id/:step", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id, step } = stepParam.parse(request.params);
    return moveVisitor(db, mail(request), actor.centreId, { source: "staff", userId: actor.userId }, id, step);
  });

  app.get("/visitors/:id", { preHandler: read }, async (request) => {
    const { id } = idParam.parse(request.params);
    const visitor = await visitorRows(db, request.user!.centreId).where("v.id", "=", id).executeTakeFirst();
    if (!visitor) throw notFound("visitor");
    return visitor;
  });
};
