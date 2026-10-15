import type { FastifyPluginAsync } from "fastify";
import type { Transaction } from "kysely";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { hashPassword, PASSWORD_MIN_LENGTH } from "../auth/passwords.js";
import { deleteUserSessions } from "../auth/sessions.js";
import type { Database, Role } from "../db/types.js";
import { conflict, notFound } from "../errors.js";

const role = z.enum(["admin", "secretariat", "accountant"]);
const createBody = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    fullName: z.string().trim().min(1).max(200),
    role,
    password: z.string().min(PASSWORD_MIN_LENGTH).max(1024),
  })
  .strict();
const updateBody = z.object({ fullName: z.string().trim().min(1).max(200), role, active: z.boolean() }).partial().strict();
const resetBody = z.object({ password: z.string().min(PASSWORD_MIN_LENGTH).max(1024) }).strict();
const idParam = z.object({ id: z.string().uuid() });

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  active: boolean;
  last_login_at: Date | null;
}

const present = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  fullName: u.full_name,
  role: u.role,
  active: u.active,
  lastLoginAt: u.last_login_at,
});

const PUBLIC_COLUMNS = ["id", "email", "full_name", "role", "active", "last_login_at"] as const;

/** The centre must always keep at least one active administrator. */
async function assertAnotherActiveAdmin(trx: Transaction<Database>, centreId: string, excludingUserId: string) {
  const row = await trx
    .selectFrom("users")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("centre_id", "=", centreId)
    .where("role", "=", "admin")
    .where("active", "=", true)
    .where("id", "!=", excludingUserId)
    .executeTakeFirstOrThrow();
  if (Number(row.count) === 0) throw conflict("last_admin", "the centre must keep at least one active administrator");
}

export const userRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  app.addHook("preHandler", app.requirePermission("users:manage"));

  app.get("/", async (request) => {
    const rows = await db
      .selectFrom("users")
      .select(PUBLIC_COLUMNS)
      .where("centre_id", "=", request.user!.centreId)
      .orderBy("full_name")
      .execute();
    return rows.map(present);
  });

  app.post("/", async (request, reply) => {
    const actor = request.user!;
    const body = createBody.parse(request.body);
    const hash = await hashPassword(body.password);
    const created = await db.transaction().execute(async (trx) => {
      const user = await trx
        .insertInto("users")
        .values({ centre_id: actor.centreId, email: body.email, full_name: body.fullName, role: body.role, password_hash: hash })
        .returning(PUBLIC_COLUMNS)
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "user.created",
        objectType: "user",
        objectId: user.id,
        after: present(user),
      });
      return user;
    });
    return reply.status(201).send(present(created));
  });

  app.patch("/:id", async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = updateBody.parse(request.body);
    const updated = await db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom("users")
        .select(PUBLIC_COLUMNS)
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw notFound("user");
      const losesAdmin = before.role === "admin" && before.active && (body.active === false || (body.role !== undefined && body.role !== "admin"));
      if (losesAdmin) await assertAnotherActiveAdmin(trx, actor.centreId, id);
      const after = await trx
        .updateTable("users")
        .set({
          ...(body.fullName === undefined ? {} : { full_name: body.fullName }),
          ...(body.role === undefined ? {} : { role: body.role }),
          ...(body.active === undefined ? {} : { active: body.active }),
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .returning(PUBLIC_COLUMNS)
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "user.updated",
        objectType: "user",
        objectId: id,
        before: present(before),
        after: present(after),
      });
      return after;
    });
    if (body.active === false || body.role !== undefined) await deleteUserSessions(db, id);
    return present(updated);
  });

  app.post("/:id/password", async (request, reply) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = resetBody.parse(request.body);
    const hash = await hashPassword(body.password);
    await db.transaction().execute(async (trx) => {
      const result = await trx
        .updateTable("users")
        .set({ password_hash: hash, failed_login_count: 0, locked_until: null, updated_at: new Date() })
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) throw notFound("user");
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "user.password_reset",
        objectType: "user",
        objectId: id,
      });
    });
    await deleteUserSessions(db, id);
    return reply.status(204).send();
  });
};
