import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { can } from "../auth/permissions.js";
import { forbidden } from "../errors.js";

const query = z.object({ q: z.string().trim().min(2).max(60) });

/** Global search of the sidebar: students, instructors and receipts by number, limited to what the role may see. */
export const searchRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  app.get("/", async (request) => {
    const user = request.user;
    if (!user) throw forbidden();
    const { q } = query.parse(request.query);
    const pattern = `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const students = can(user, "students:read")
      ? await db
          .selectFrom("students")
          .select(["id", "first_name as firstName", "last_name as lastName", "phone", "status"])
          .where("centre_id", "=", user.centreId)
          .where((eb) =>
            eb.or([
              eb(sql`lower(first_name || ' ' || last_name)`, "like", pattern),
              eb(sql`lower(last_name || ' ' || first_name)`, "like", pattern),
              eb(sql`coalesce(phone, '')`, "like", pattern),
            ]),
          )
          .orderBy("last_name")
          .limit(8)
          .execute()
      : [];
    const instructors = can(user, "instructors:read")
      ? await db
          .selectFrom("instructors")
          .select(["id", "first_name as firstName", "last_name as lastName", "status"])
          .where("centre_id", "=", user.centreId)
          .where((eb) =>
            eb.or([eb(sql`lower(first_name || ' ' || last_name)`, "like", pattern), eb(sql`lower(last_name || ' ' || first_name)`, "like", pattern)]),
          )
          .orderBy("last_name")
          .limit(5)
          .execute()
      : [];
    const receipts = can(user, "payments:read")
      ? await db
          .selectFrom("receipts")
          .select(["id", "number", "kind"])
          .where("centre_id", "=", user.centreId)
          .where(sql`lower(number)`, "like", pattern)
          .orderBy("number", "desc")
          .limit(5)
          .execute()
      : [];
    return { students, instructors, receipts };
  });
};
