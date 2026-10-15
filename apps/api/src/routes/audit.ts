import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const listQuery = z.object({
  userId: z.string().uuid().optional(),
  objectType: z.string().trim().min(1).max(50).optional(),
  objectId: z.string().trim().min(1).max(100).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const auditRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;

  app.get("/", { preHandler: app.requirePermission("audit:read") }, async (request) => {
    const query = listQuery.parse(request.query);
    let base = db.selectFrom("audit_log").leftJoin("users", "users.id", "audit_log.user_id").where("audit_log.centre_id", "=", request.user!.centreId);
    if (query.userId) base = base.where("audit_log.user_id", "=", query.userId);
    if (query.objectType) base = base.where("audit_log.object_type", "=", query.objectType);
    if (query.objectId) base = base.where("audit_log.object_id", "=", query.objectId);
    if (query.from) base = base.where("audit_log.at", ">=", new Date(query.from));
    if (query.to) base = base.where("audit_log.at", "<", new Date(query.to));
    const rows = await base
      .select([
        "audit_log.id",
        "audit_log.at",
        "audit_log.user_id as userId",
        "users.full_name as userName",
        "audit_log.action",
        "audit_log.object_type as objectType",
        "audit_log.object_id as objectId",
        "audit_log.before",
        "audit_log.after",
        "audit_log.reason",
      ])
      .orderBy("audit_log.id", "desc")
      .limit(query.pageSize + 1)
      .offset((query.page - 1) * query.pageSize)
      .execute();
    return { items: rows.slice(0, query.pageSize), hasMore: rows.length > query.pageSize, page: query.page };
  });
};
