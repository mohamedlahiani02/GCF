import { OCCUPYING_STATUSES } from "@gcf/shared";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { sql } from "kysely";
import { centreCalendar } from "../../domain/coworking/schedule.js";
import { forbidden } from "../../errors.js";
import { signedIn } from "./context.js";

const occupying = [...OCCUPYING_STATUSES];

/** The company's members and their bookings to come, for the member who administers the company account (portal). */
export const portalTeamRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;

  /** Only a company admin sees the team; the role is read from the database, not from the session. */
  const companyAdmin = async (request: FastifyRequest) => {
    const portal = await signedIn(db, request);
    const row = await db.selectFrom("members").select(["company_id", "company_role"]).where("id", "=", portal.member.memberId).executeTakeFirstOrThrow();
    if (!row.company_id || row.company_role !== "admin") throw forbidden();
    return { ...portal, companyId: row.company_id };
  };

  app.get("/team", async (request) => {
    const { centre, member, companyId } = await companyAdmin(request);
    const now = new Date();
    const company = await db.selectFrom("companies").select(["id", "name"]).where("id", "=", companyId).executeTakeFirstOrThrow();
    const members = await db
      .selectFrom("members as m")
      .select([
        "m.id",
        "m.first_name as firstName",
        "m.last_name as lastName",
        "m.company_role as companyRole",
        "m.status",
        sql<number>`(select count(*)::integer from cw_bookings b where b.member_id = m.id and b.kind = 'booking'
          and b.status = any(${occupying}::text[]) and b.ends_at > ${now})`.as("upcomingBookings"),
      ])
      .where("m.company_id", "=", companyId)
      .where("m.centre_id", "=", centre.id)
      .where("m.status", "!=", "disabled")
      .orderBy(sql`lower(m.first_name)`)
      .orderBy(sql`lower(coalesce(m.last_name, ''))`)
      .execute();
    return { company, members: members.map((m) => ({ ...m, isMe: m.id === member.memberId })) };
  });

  /** Bookings to come of the other members of the company, without prices: when and where each colleague is. */
  app.get("/team/bookings", async (request) => {
    const { centre, member, companyId } = await companyAdmin(request);
    const { timezone } = await centreCalendar(db, centre.id);
    const items = await db
      .selectFrom("cw_bookings as b")
      .innerJoin("members as m", "m.id", "b.member_id")
      .innerJoin("cw_resources as r", "r.id", "b.resource_id")
      .innerJoin("cw_resource_types as t", "t.id", "r.type_id")
      .select([
        "b.id",
        "m.id as memberId",
        sql<string>`concat_ws(' ', m.first_name, m.last_name)`.as("memberName"),
        sql<string>`to_char(b.starts_at at time zone ${timezone}, 'YYYY-MM-DD')`.as("date"),
        sql<string>`to_char(b.starts_at at time zone ${timezone}, 'HH24:MI')`.as("startTime"),
        sql<string>`to_char(b.ends_at at time zone ${timezone}, 'HH24:MI')`.as("endTime"),
        sql<Date>`b.starts_at`.as("startsAt"),
        sql<Date>`b.ends_at`.as("endsAt"),
        "r.code as resourceCode",
        "t.name as typeName",
        "t.category",
        "b.status",
      ])
      .where("b.centre_id", "=", centre.id)
      .where("b.kind", "=", "booking")
      .where("m.company_id", "=", companyId)
      .where("m.id", "!=", member.memberId)
      .where("b.status", "in", occupying)
      .where("b.ends_at", ">", new Date())
      .orderBy("b.starts_at")
      .orderBy("b.id")
      .limit(500)
      .execute();
    return { items };
  });
};
