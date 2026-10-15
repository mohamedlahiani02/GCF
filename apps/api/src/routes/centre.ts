import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { notFound } from "../errors.js";
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

export const centreRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;

  const load = async (centreId: string) => {
    const centre = await db.selectFrom("centres").selectAll().where("id", "=", centreId).executeTakeFirst();
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
  });

  app.get("/", { preHandler: app.requirePermission("centre:read") }, async (request) => {
    return present(await load(request.user!.centreId));
  });

  app.patch("/", { preHandler: app.requirePermission("centre:manage") }, async (request) => {
    const user = request.user!;
    const body = centreUpdate.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom("centres").selectAll().where("id", "=", user.centreId).forUpdate().executeTakeFirst();
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
        .returningAll()
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
};
