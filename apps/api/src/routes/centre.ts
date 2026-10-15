import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { notFound } from "../errors.js";

const nullableText = z.string().trim().max(500).transform((v) => (v === "" ? null : v)).nullable();

const centreUpdate = z
  .object({
    name: z.string().trim().min(1).max(200),
    address: nullableText,
    taxId: nullableText,
    locale: z.enum(["fr", "ar"]),
    timezone: z.string().refine((tz) => Intl.supportedValuesOf("timeZone").includes(tz), "unknown time zone"),
    majorityAge: z.number().int().min(1).max(30),
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
    majorityAge: c.majority_age,
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
          ...(body.majorityAge === undefined ? {} : { majority_age: body.majorityAge }),
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
