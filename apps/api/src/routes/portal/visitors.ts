import { todayIn } from "@gcf/shared";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import type { MailContext } from "../../domain/coworking/bookings.js";
import { centreCalendar } from "../../domain/coworking/schedule.js";
import { announceVisitor, moveVisitor, visitorRows } from "../../domain/coworking/visitors.js";
import { idParam } from "../../validation.js";
import { visitorFields } from "../coworking/visitors.js";
import { signedIn } from "./context.js";

const announceBody = z.object(visitorFields).strict();

/** The member's own guests: announce one, see those to come, cancel one (portal). */
export const portalVisitorRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app;
  const mail = (request: FastifyRequest): MailContext => ({ mailer: app.mailer, log: request.log, publicOrigin: config.publicOrigin });

  app.get("/visitors", async (request) => {
    const { centre, member } = await signedIn(db, request);
    const { timezone } = await centreCalendar(db, centre.id);
    const rows = await visitorRows(db, centre.id)
      .where("v.host_member_id", "=", member.memberId)
      .where("v.expected_on", ">=", todayIn(timezone))
      .where("v.status", "!=", "cancelled")
      .orderBy("v.expected_on")
      .orderBy("v.expected_at")
      .execute();
    return rows.map(({ hostMemberId: _host, hostName: _name, hostCompany: _company, ...v }) => v);
  });

  app.post("/visitors", async (request, reply) => {
    const { centre, member } = await signedIn(db, request);
    const body = announceBody.parse(request.body);
    const {
      hostMemberId: _host,
      hostName: _name,
      hostCompany: _company,
      ...visitor
    } = await announceVisitor(db, centre.id, { source: "portal", memberId: member.memberId }, { ...body, hostMemberId: member.memberId });
    return reply.status(201).send(visitor);
  });

  app.post("/visitors/:id/cancel", async (request) => {
    const { centre, member } = await signedIn(db, request);
    const { id } = idParam.parse(request.params);
    const {
      hostMemberId: _host,
      hostName: _name,
      hostCompany: _company,
      ...visitor
    } = await moveVisitor(db, mail(request), centre.id, { source: "portal", memberId: member.memberId }, id, "cancel");
    return visitor;
  });
};
