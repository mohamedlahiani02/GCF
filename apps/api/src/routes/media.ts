import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { can, type Permission } from "../auth/permissions.js";
import { forbidden, notFound, unauthenticated } from "../errors.js";
import { decodeImage, MEDIA_MAX_BYTES } from "../site/images.js";
import { idParam, optionalText } from "../validation.js";

// Base64 makes the upload 4/3 larger than the file; the margin covers the data URL prefix and the other fields.
const UPLOAD_BODY_LIMIT = Math.ceil(MEDIA_MAX_BYTES / 3) * 4 + 16 * 1024;

const folder = optionalText(60);
const uploadBody = z.object({ image: z.string(), alt: optionalText(300), folder }).strict();
const updateBody = z.object({ alt: optionalText(300), folder }).strict();
const listQuery = z.object({
  folder: z.string().trim().min(1).max(60).optional(),
  status: z.enum(["active", "archived"]).default("active"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

// Every column but the bytes, which only the file endpoints read.
const MEDIA_COLUMNS = ["id", "mime", "bytes", "width", "height", "sha256", "alt", "folder", "status", "created_at"] as const;

interface MediaRow {
  id: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  alt: string | null;
  folder: string | null;
  status: "active" | "archived";
  created_at: Date;
}

const present = (m: MediaRow) => ({
  id: m.id,
  mime: m.mime,
  bytes: m.bytes,
  width: m.width,
  height: m.height,
  sha256: m.sha256,
  alt: m.alt,
  folder: m.folder,
  status: m.status,
  createdAt: m.created_at,
  url: `/api/media/${m.id}/file`,
});

/** Passes when the signed-in user holds at least one of the permissions. */
function requireAnyPermission(...permissions: Permission[]) {
  return async (request: FastifyRequest) => {
    if (!request.user) throw unauthenticated();
    if (!permissions.some((p) => can(request.user!, p))) throw forbidden();
  };
}

/** Media library shared by the coworking plans and the website (staff). */
export const mediaRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  // Floor plans are uploaded by coworking managers, website images by editors.
  const write = requireAnyPermission("website:edit", "coworking:manage");
  const read = requireAnyPermission("website:edit", "coworking:read");

  app.get("/", { preHandler: read }, async (request) => {
    const query = listQuery.parse(request.query);
    let base = db.selectFrom("media_files").where("centre_id", "=", request.user!.centreId).where("status", "=", query.status);
    if (query.folder) base = base.where("folder", "=", query.folder);
    const rows = await base
      .select(MEDIA_COLUMNS)
      .orderBy("created_at", "desc")
      .orderBy("id")
      .limit(query.pageSize + 1)
      .offset((query.page - 1) * query.pageSize)
      .execute();
    return { items: rows.slice(0, query.pageSize).map(present), hasMore: rows.length > query.pageSize, page: query.page };
  });

  app.post("/", { preHandler: write, bodyLimit: UPLOAD_BODY_LIMIT }, async (request, reply) => {
    const actor = request.user!;
    const body = uploadBody.parse(request.body);
    const image = decodeImage(body.image);
    const sha256 = createHash("sha256").update(image.bytes).digest("hex");
    const created = await db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto("media_files")
        .values({
          centre_id: actor.centreId,
          data: image.bytes,
          mime: image.mime,
          bytes: image.bytes.length,
          width: image.width,
          height: image.height,
          sha256,
          alt: body.alt ?? null,
          folder: body.folder ?? null,
          created_by: actor.userId,
        })
        .returning(MEDIA_COLUMNS)
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "media.uploaded",
        objectType: "media_file",
        objectId: row.id,
        after: { mime: row.mime, bytes: row.bytes, width: row.width, height: row.height, sha256, folder: row.folder },
      });
      return row;
    });
    return reply.status(201).send(present(created));
  });

  app.get("/:id", { preHandler: read }, async (request) => {
    const { id } = idParam.parse(request.params);
    const row = await db
      .selectFrom("media_files")
      .select(MEDIA_COLUMNS)
      .where("id", "=", id)
      .where("centre_id", "=", request.user!.centreId)
      .executeTakeFirst();
    if (!row) throw notFound("media file");
    return present(row);
  });

  app.patch("/:id", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = updateBody.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom("media_files")
        .select(MEDIA_COLUMNS)
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw notFound("media file");
      const after = await trx
        .updateTable("media_files")
        .set({
          ...(body.alt === undefined ? {} : { alt: body.alt }),
          ...(body.folder === undefined ? {} : { folder: body.folder }),
        })
        .where("id", "=", id)
        .returning(MEDIA_COLUMNS)
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "media.updated",
        objectType: "media_file",
        objectId: id,
        before: { alt: before.alt, folder: before.folder },
        after: { alt: after.alt, folder: after.folder },
      });
      return present(after);
    });
  });

  // Archived files leave the library but keep being served, so pages already published never lose an image.
  app.post("/:id/archive", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    return db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom("media_files")
        .select(MEDIA_COLUMNS)
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw notFound("media file");
      if (before.status === "archived") return present(before);
      const after = await trx.updateTable("media_files").set({ status: "archived" }).where("id", "=", id).returning(MEDIA_COLUMNS).executeTakeFirstOrThrow();
      await writeAudit(trx, { centreId: actor.centreId, userId: actor.userId, action: "media.archived", objectType: "media_file", objectId: id });
      return present(after);
    });
  });

  // A media id never changes content, so the browser may keep the bytes for good.
  app.get("/:id/file", { preHandler: read }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const row = await db
      .selectFrom("media_files")
      .select(["data", "mime"])
      .where("id", "=", id)
      .where("centre_id", "=", request.user!.centreId)
      .executeTakeFirst();
    if (!row) throw notFound("media file");
    return reply.header("content-type", row.mime).header("cache-control", "private, max-age=31536000, immutable").send(row.data);
  });
};
