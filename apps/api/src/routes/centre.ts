import { createHash } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { notFound, unprocessable } from "../errors.js";
import { clockTime } from "../validation.js";

const nullableText = z
  .string()
  .trim()
  .max(500)
  .transform((v) => (v === "" ? null : v))
  .nullable();

const centreUpdate = z
  .object({
    name: z.string().trim().min(1).max(200),
    address: nullableText,
    taxId: nullableText,
    locale: z.enum(["fr", "ar"]),
    timezone: z.string().refine((tz) => Intl.supportedValuesOf("timeZone").includes(tz), "unknown time zone"),
    countJustifiedAsPresent: z.boolean(),
    countMakeupAsPresent: z.boolean(),
    postponementRequiresApproval: z.boolean(),
    maxPostponements: z.number().int().min(0).max(12),
    overdueGraceDays: z.number().int().min(0).max(60),
    receiptPrefix: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{1,10}$/, "1 to 10 capital letters or digits"),
    receiptFooter: nullableText,
    openFrom: clockTime,
    openTo: clockTime,
    openWeekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  })
  .partial()
  .strict();

/** Largest logo accepted, in bytes; the database enforces the same limit. */
export const LOGO_MAX_BYTES = 512 * 1024;
type LogoMime = "image/png" | "image/jpeg" | "image/webp";

// The request body limit (1 MiB) bounds the upload; parseLogo enforces the logo limit itself.
const logoBody = z.object({ image: z.string() }).strict();

/** Identifies the image from its first bytes, so a file is never stored under a type it does not have. */
function sniffImage(bytes: Buffer): LogoMime | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Decodes a `data:image/...;base64,` URL into a PNG, JPEG or WebP image within the size limit. */
export function parseLogo(dataUrl: string): { bytes: Buffer; mime: LogoMime } {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw unprocessable("invalid_logo", "the logo must be a PNG, JPEG or WebP image");
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.length === 0) throw unprocessable("invalid_logo", "the logo is empty");
  if (bytes.length > LOGO_MAX_BYTES) throw unprocessable("logo_too_large", `the logo cannot exceed ${LOGO_MAX_BYTES} bytes`);
  const mime = sniffImage(bytes);
  if (!mime || mime !== match[1]) throw unprocessable("invalid_logo", "the logo must be a PNG, JPEG or WebP image");
  return { bytes, mime };
}

// Every column but the logo itself, which only GET /logo reads.
const CENTRE_COLUMNS = [
  "id",
  "name",
  "address",
  "tax_id",
  "currency",
  "currency_decimals",
  "locale",
  "timezone",
  "count_justified_as_present",
  "count_makeup_as_present",
  "postponement_requires_approval",
  "max_postponements",
  "overdue_grace_days",
  "receipt_prefix",
  "receipt_footer",
  "open_from",
  "open_to",
  "open_weekdays",
  "logo_updated_at",
] as const;

export const centreRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;

  const load = async (centreId: string) => {
    const centre = await db.selectFrom("centres").select(CENTRE_COLUMNS).where("id", "=", centreId).executeTakeFirst();
    if (!centre) throw notFound("centre");
    return centre;
  };

  const present = (c: Awaited<ReturnType<typeof load>>) => ({
    id: c.id,
    name: c.name,
    address: c.address,
    taxId: c.tax_id,
    currency: c.currency,
    currencyDecimals: c.currency_decimals,
    locale: c.locale,
    timezone: c.timezone,
    countJustifiedAsPresent: c.count_justified_as_present,
    countMakeupAsPresent: c.count_makeup_as_present,
    postponementRequiresApproval: c.postponement_requires_approval,
    maxPostponements: c.max_postponements,
    overdueGraceDays: c.overdue_grace_days,
    receiptPrefix: c.receipt_prefix,
    receiptFooter: c.receipt_footer,
    openFrom: c.open_from.slice(0, 5),
    openTo: c.open_to.slice(0, 5),
    openWeekdays: c.open_weekdays,
    // Changes with each new logo, so the browser can cache the image until it is replaced.
    logoVersion: c.logo_updated_at ? c.logo_updated_at.getTime() : null,
  });

  app.get("/", { preHandler: app.requirePermission("centre:read") }, async (request) => {
    return present(await load(request.user!.centreId));
  });

  app.patch("/", { preHandler: app.requirePermission("centre:manage") }, async (request) => {
    const user = request.user!;
    const body = centreUpdate.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom("centres").select(CENTRE_COLUMNS).where("id", "=", user.centreId).forUpdate().executeTakeFirst();
      if (!before) throw notFound("centre");
      const after = await trx
        .updateTable("centres")
        .set({
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.address === undefined ? {} : { address: body.address }),
          ...(body.taxId === undefined ? {} : { tax_id: body.taxId }),
          ...(body.locale === undefined ? {} : { locale: body.locale }),
          ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
          ...(body.countJustifiedAsPresent === undefined ? {} : { count_justified_as_present: body.countJustifiedAsPresent }),
          ...(body.countMakeupAsPresent === undefined ? {} : { count_makeup_as_present: body.countMakeupAsPresent }),
          ...(body.postponementRequiresApproval === undefined ? {} : { postponement_requires_approval: body.postponementRequiresApproval }),
          ...(body.maxPostponements === undefined ? {} : { max_postponements: body.maxPostponements }),
          ...(body.overdueGraceDays === undefined ? {} : { overdue_grace_days: body.overdueGraceDays }),
          ...(body.receiptPrefix === undefined ? {} : { receipt_prefix: body.receiptPrefix }),
          ...(body.receiptFooter === undefined ? {} : { receipt_footer: body.receiptFooter }),
          ...(body.openFrom === undefined ? {} : { open_from: body.openFrom }),
          ...(body.openTo === undefined ? {} : { open_to: body.openTo }),
          ...(body.openWeekdays === undefined ? {} : { open_weekdays: [...new Set(body.openWeekdays)].sort() }),
          updated_at: new Date(),
        })
        .where("id", "=", user.centreId)
        .returning(CENTRE_COLUMNS)
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: user.centreId,
        userId: user.userId,
        action: "centre.updated",
        objectType: "centre",
        objectId: user.centreId,
        before: present(before),
        after: present(after),
      });
      return present(after);
    });
  });

  app.get("/logo", { preHandler: app.requirePermission("centre:read") }, async (request, reply) => {
    const centre = await db.selectFrom("centres").select(["logo", "logo_mime"]).where("id", "=", request.user!.centreId).executeTakeFirst();
    if (!centre?.logo || !centre.logo_mime) throw notFound("logo");
    return reply.header("content-type", centre.logo_mime).header("cache-control", "private, max-age=31536000, immutable").send(centre.logo);
  });

  app.put("/logo", { preHandler: app.requirePermission("centre:manage") }, async (request) => {
    const user = request.user!;
    const { bytes, mime } = parseLogo(logoBody.parse(request.body).image);
    return db.transaction().execute(async (trx) => {
      const after = await trx
        .updateTable("centres")
        .set({ logo: bytes, logo_mime: mime, logo_updated_at: new Date(), updated_at: new Date() })
        .where("id", "=", user.centreId)
        .returning(CENTRE_COLUMNS)
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: user.centreId,
        userId: user.userId,
        action: "centre.logo_updated",
        objectType: "centre",
        objectId: user.centreId,
        after: { mime, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
      });
      return present(after);
    });
  });

  app.delete("/logo", { preHandler: app.requirePermission("centre:manage") }, async (request) => {
    const user = request.user!;
    return db.transaction().execute(async (trx) => {
      const after = await trx
        .updateTable("centres")
        .set({ logo: null, logo_mime: null, logo_updated_at: null, updated_at: new Date() })
        .where("id", "=", user.centreId)
        .returning(CENTRE_COLUMNS)
        .executeTakeFirstOrThrow();
      await writeAudit(trx, { centreId: user.centreId, userId: user.userId, action: "centre.logo_removed", objectType: "centre", objectId: user.centreId });
      return present(after);
    });
  });
};
