import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { assertCafeOpen, cafeDay, cafeSettings, lockCafeTill, moveStock, nextSaleNumber } from "../domain/cafe.js";
import { recordFinancialEvents } from "../domain/financialEvents.js";
import { centreClock } from "../domain/ledger.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { idParam, isoDate, millimes, optionalText, reason, requiredText, uuid } from "../validation.js";

const quantity = z.number().int().min(1).max(100_000);
const settingsBody = z
  .object({
    openingFloat: millimes,
    allowNegativeStock: z.boolean(),
    ticketPrefix: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{1,8}$/, "1 to 8 capital letters or digits"),
  })
  .strict();
const productBody = z
  .object({
    name: requiredText(80),
    category: optionalText(60),
    price: millimes,
    trackStock: z.boolean(),
    lowStockThreshold: z.number().int().min(0).max(100_000).nullable().optional(),
  })
  .strict();
const productPatch = productBody.partial().extend({ active: z.boolean().optional() }).strict();
const stockBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("purchase"), quantity, unitCost: millimes.nullable().optional(), reason: optionalText(500) }).strict(),
  z.object({ kind: z.literal("loss"), quantity, reason }).strict(),
  z.object({ kind: z.literal("count"), counted: z.number().int().min(0).max(1_000_000), reason }).strict(),
]);
const saleBody = z
  .object({
    lines: z
      .array(z.object({ productId: uuid, quantity }).strict())
      .min(1)
      .max(100)
      .refine((lines) => new Set(lines.map((l) => l.productId)).size === lines.length, "a product appears once per sale"),
    method: z.enum(["cash", "card"]),
    /** The total the seller saw: the sale is refused when a price changed in between. */
    expectedTotal: millimes,
    cashReceived: millimes.optional(),
  })
  .strict();
const cancelBody = z.object({ reason }).strict();
const closeBody = z.object({ day: isoDate, countedCash: millimes, comment: z.string().trim().max(1000).optional() }).strict();

const productColumns = [
  "id",
  "name",
  "category",
  "price",
  "track_stock as trackStock",
  "stock_quantity as stockQuantity",
  "low_stock_threshold as lowStockThreshold",
  "active",
] as const;

export const cafeRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const read = app.requirePermission("cafe:read");
  const manage = app.requirePermission("cafe:manage");

  app.get("/settings", { preHandler: read }, async (request) => cafeSettings(db, request.user!.centreId));

  app.put("/settings", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const body = settingsBody.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const before = await cafeSettings(trx, actor.centreId);
      const values = {
        opening_float: body.openingFloat,
        allow_negative_stock: body.allowNegativeStock,
        ticket_prefix: body.ticketPrefix,
        updated_by: actor.userId,
        updated_at: new Date(),
      };
      await trx
        .insertInto("cafe_settings")
        .values({ centre_id: actor.centreId, ...values })
        .onConflict((oc) => oc.column("centre_id").doUpdateSet(values))
        .execute();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "cafe.settings_changed",
        objectType: "cafe_settings",
        objectId: actor.centreId,
        before,
        after: body,
      });
      return body;
    });
  });

  app.get("/products", { preHandler: read }, async (request) => {
    const { all } = z.object({ all: z.enum(["true", "false"]).default("false") }).parse(request.query);
    let query = db.selectFrom("cafe_products").select(productColumns).where("centre_id", "=", request.user!.centreId);
    if (all === "false") query = query.where("active", "=", true);
    return query.orderBy("category").orderBy("name").execute();
  });

  app.post("/products", { preHandler: manage }, async (request, reply) => {
    const actor = request.user!;
    const body = productBody.parse(request.body);
    const product = await db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto("cafe_products")
        .values({
          centre_id: actor.centreId,
          name: body.name,
          category: body.category ?? null,
          price: body.price,
          track_stock: body.trackStock,
          low_stock_threshold: body.lowStockThreshold ?? null,
        })
        .returning(productColumns)
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "cafe.product_created",
        objectType: "cafe_product",
        objectId: created.id,
        after: created,
      });
      return created;
    });
    return reply.status(201).send(product);
  });

  app.patch("/products/:id", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = productPatch.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom("cafe_products")
        .select(productColumns)
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw notFound("product");
      const after = await trx
        .updateTable("cafe_products")
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.category !== undefined ? { category: body.category } : {}),
          ...(body.price !== undefined ? { price: body.price } : {}),
          ...(body.trackStock !== undefined ? { track_stock: body.trackStock } : {}),
          ...(body.lowStockThreshold !== undefined ? { low_stock_threshold: body.lowStockThreshold } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .returning(productColumns)
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "cafe.product_updated",
        objectType: "cafe_product",
        objectId: id,
        before,
        after,
      });
      return after;
    });
  });

  /** A delivery, a loss, or a physical count that corrects the quantity. Sales move the stock on their own. */
  app.post("/products/:id/stock", { preHandler: manage }, async (request, reply) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = stockBody.parse(request.body);
    const result = await db.transaction().execute(async (trx) => {
      const product = await trx
        .selectFrom("cafe_products")
        .select(["id", "track_stock as trackStock", "stock_quantity as stockQuantity"])
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!product) throw notFound("product");
      if (!product.trackStock) throw unprocessable("stock_not_tracked", "this product has no stock to follow");
      const signed = body.kind === "purchase" ? body.quantity : body.kind === "loss" ? -body.quantity : body.counted - product.stockQuantity;
      if (signed === 0) throw unprocessable("no_difference", "the counted quantity is the quantity already recorded");
      const { allowNegativeStock } = await cafeSettings(trx, actor.centreId);
      const quantityAfter = await moveStock(trx, {
        centreId: actor.centreId,
        productId: id,
        kind: body.kind,
        quantity: signed,
        unitCost: body.kind === "purchase" ? (body.unitCost ?? null) : null,
        reason: body.reason ?? null,
        userId: actor.userId,
        allowNegative: allowNegativeStock,
      });
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: `cafe.stock_${body.kind}`,
        objectType: "cafe_product",
        objectId: id,
        before: { stockQuantity: product.stockQuantity },
        after: { stockQuantity: quantityAfter, quantity: signed },
        reason: body.reason ?? null,
      });
      return { productId: id, quantity: signed, stockQuantity: quantityAfter };
    });
    return reply.status(201).send(result);
  });

  app.get("/products/:id/movements", { preHandler: read }, async (request) => {
    const { id } = idParam.parse(request.params);
    return db
      .selectFrom("cafe_stock_movements")
      .leftJoin("users", "users.id", "cafe_stock_movements.created_by")
      .leftJoin("cafe_sales", "cafe_sales.id", "cafe_stock_movements.sale_id")
      .select([
        "cafe_stock_movements.id",
        "cafe_stock_movements.kind",
        "cafe_stock_movements.quantity",
        "cafe_stock_movements.quantity_after as quantityAfter",
        "cafe_stock_movements.unit_cost as unitCost",
        "cafe_stock_movements.reason",
        "cafe_stock_movements.created_at as createdAt",
        "cafe_sales.number as saleNumber",
        "users.full_name as createdBy",
      ])
      .where("cafe_stock_movements.product_id", "=", id)
      .where("cafe_stock_movements.centre_id", "=", request.user!.centreId)
      .orderBy("cafe_stock_movements.created_at", "desc")
      .orderBy("cafe_stock_movements.id")
      .limit(100)
      .execute();
  });

  /** Prices and names are read on the server; the client only says what was sold and how it was paid. */
  app.post("/sales", { preHandler: app.requirePermission("cafe:sell") }, async (request, reply) => {
    const actor = request.user!;
    const body = saleBody.parse(request.body);
    const sale = await db.transaction().execute(async (trx) => {
      await lockCafeTill(trx, actor.centreId);
      const { today } = await centreClock(trx, actor.centreId);
      await assertCafeOpen(trx, actor.centreId, today);
      const settings = await cafeSettings(trx, actor.centreId);
      const products = await trx
        .selectFrom("cafe_products")
        .select(["id", "name", "price", "active", "track_stock as trackStock"])
        .where("centre_id", "=", actor.centreId)
        .where(
          "id",
          "in",
          body.lines.map((l) => l.productId),
        )
        .execute();
      const lines = body.lines.map((line) => {
        const product = products.find((p) => p.id === line.productId);
        if (!product) throw notFound("product");
        if (!product.active) throw unprocessable("product_inactive", `${product.name} is no longer sold`, { productId: product.id });
        return { ...line, product, lineTotal: product.price * line.quantity };
      });
      const total = lines.reduce((sum, l) => sum + l.lineTotal, 0);
      if (total <= 0) throw unprocessable("empty_sale", "a sale needs an amount to collect");
      if (total !== body.expectedTotal) throw conflict("price_changed", "a price changed since the sale was prepared");
      if (body.method !== "cash" && body.cashReceived !== undefined) throw unprocessable("cash_received_not_cash", "cash received only applies to cash");
      if (body.cashReceived !== undefined && body.cashReceived < total) throw unprocessable("insufficient_cash", "the cash received does not cover the sale");
      const number = await nextSaleNumber(trx, actor.centreId, settings.ticketPrefix, Number(today.slice(0, 4)));
      const created = await trx
        .insertInto("cafe_sales")
        .values({
          centre_id: actor.centreId,
          number,
          day: today,
          method: body.method,
          total,
          cash_received: body.cashReceived ?? null,
          created_by: actor.userId,
        })
        .returning(["id", "number", "day", "sold_at as soldAt", "method", "total", "cash_received as cashReceived"])
        .executeTakeFirstOrThrow();
      await trx
        .insertInto("cafe_sale_lines")
        .values(
          lines.map((l) => ({
            sale_id: created.id,
            centre_id: actor.centreId,
            product_id: l.product.id,
            product_name: l.product.name,
            unit_price: l.product.price,
            quantity: l.quantity,
            line_total: l.lineTotal,
          })),
        )
        .execute();
      // Products are locked in a stable order so two concurrent sales cannot deadlock.
      for (const l of [...lines].sort((a, b) => a.product.id.localeCompare(b.product.id))) {
        if (!l.product.trackStock) continue;
        await moveStock(trx, {
          centreId: actor.centreId,
          productId: l.product.id,
          kind: "sale",
          quantity: -l.quantity,
          saleId: created.id,
          userId: actor.userId,
          allowNegative: settings.allowNegativeStock,
        });
      }
      const result = {
        ...created,
        change: body.cashReceived === undefined ? null : body.cashReceived - total,
        lines: lines.map((l) => ({ productName: l.product.name, quantity: l.quantity, unitPrice: l.product.price, lineTotal: l.lineTotal })),
      };
      await recordFinancialEvents(trx, [
        { centreId: actor.centreId, type: "cafe_sale", amount: total, userId: actor.userId, payload: { saleId: created.id, number, method: body.method } },
      ]);
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "cafe.sale_recorded",
        objectType: "cafe_sale",
        objectId: created.id,
        after: result,
      });
      return result;
    });
    return reply.status(201).send(sale);
  });

  /** Cancels a sale of a day that is still open and puts its products back in stock. */
  app.post("/sales/:id/cancel", { preHandler: app.requirePermission("cafe:cancel") }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = cancelBody.parse(request.body);
    return db.transaction().execute(async (trx) => {
      await lockCafeTill(trx, actor.centreId);
      const sale = await trx
        .selectFrom("cafe_sales")
        .select(["id", "number", "day", "method", "total", "status"])
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!sale) throw notFound("sale");
      if (sale.status === "cancelled") throw conflict("already_cancelled", "this sale is already cancelled");
      await assertCafeOpen(trx, actor.centreId, sale.day);
      await trx
        .updateTable("cafe_sales")
        .set({ status: "cancelled", cancelled_at: new Date(), cancelled_by: actor.userId, cancel_reason: body.reason })
        .where("id", "=", id)
        .execute();
      const moved = await trx
        .selectFrom("cafe_stock_movements")
        .select(["product_id as productId", "quantity"])
        .where("sale_id", "=", id)
        .where("kind", "=", "sale")
        .orderBy("product_id")
        .execute();
      for (const m of moved) {
        await moveStock(trx, {
          centreId: actor.centreId,
          productId: m.productId,
          kind: "sale_cancelled",
          quantity: -m.quantity,
          saleId: id,
          userId: actor.userId,
          allowNegative: true,
        });
      }
      await recordFinancialEvents(trx, [
        {
          centreId: actor.centreId,
          type: "cafe_sale_cancelled",
          amount: -sale.total,
          userId: actor.userId,
          payload: { saleId: id, number: sale.number, method: sale.method },
        },
      ]);
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "cafe.sale_cancelled",
        objectType: "cafe_sale",
        objectId: id,
        before: { status: "valid", total: sale.total },
        after: { status: "cancelled" },
        reason: body.reason,
      });
      return { id, number: sale.number, status: "cancelled" as const };
    });
  });

  app.get("/journal", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const { date } = z.object({ date: isoDate }).parse(request.query);
    const closing = await db
      .selectFrom("cafe_closings")
      .leftJoin("users", "users.id", "cafe_closings.closed_by")
      .select([
        "cafe_closings.opening_float as openingFloat",
        "cafe_closings.expected_cash as expectedCash",
        "cafe_closings.counted_cash as countedCash",
        "cafe_closings.difference",
        "cafe_closings.comment",
        "cafe_closings.closed_at as closedAt",
        "users.full_name as closedBy",
      ])
      .where("cafe_closings.centre_id", "=", centreId)
      .where("cafe_closings.day", "=", date)
      .executeTakeFirst();
    const openingFloat = closing ? closing.openingFloat : (await cafeSettings(db, centreId)).openingFloat;
    return { ...(await cafeDay(db, centreId, date, openingFloat)), closing: closing ?? null };
  });

  /** Locks the café day: expected cash is the opening float plus the cash sales, recomputed on the server. */
  app.post("/closings", { preHandler: app.requirePermission("cafe:close") }, async (request, reply) => {
    const actor = request.user!;
    const body = closeBody.parse(request.body);
    const result = await db.transaction().execute(async (trx) => {
      await lockCafeTill(trx, actor.centreId);
      const { today } = await centreClock(trx, actor.centreId);
      if (body.day > today) throw unprocessable("future_day", "a day can only be closed once it has started");
      const existing = await trx
        .selectFrom("cafe_closings")
        .select("id")
        .where("centre_id", "=", actor.centreId)
        .where("day", "=", body.day)
        .executeTakeFirst();
      if (existing) throw conflict("already_closed", "this day is already closed");
      const { openingFloat } = await cafeSettings(trx, actor.centreId);
      const day = await cafeDay(trx, actor.centreId, body.day, openingFloat);
      const difference = body.countedCash - day.expectedCash;
      if (difference !== 0 && !body.comment) throw unprocessable("comment_required", "explain the difference between expected and counted cash");
      const closing = await trx
        .insertInto("cafe_closings")
        .values({
          centre_id: actor.centreId,
          day: body.day,
          opening_float: openingFloat,
          expected_cash: day.expectedCash,
          counted_cash: body.countedCash,
          difference,
          comment: body.comment ?? null,
          totals: JSON.stringify(day.totals),
          closed_by: actor.userId,
        })
        .returning(["id", "day", "opening_float as openingFloat", "expected_cash as expectedCash", "counted_cash as countedCash", "difference", "comment"])
        .executeTakeFirstOrThrow();
      await recordFinancialEvents(trx, [
        {
          centreId: actor.centreId,
          type: "cafe_cash_closed",
          amount: difference,
          userId: actor.userId,
          payload: { day: body.day, openingFloat, expected: day.expectedCash, counted: body.countedCash, totals: day.totals },
        },
      ]);
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "cafe.closed",
        objectType: "cafe_closing",
        objectId: closing.id,
        after: closing,
        reason: body.comment ?? null,
      });
      return closing;
    });
    return reply.status(201).send(result);
  });

  app.get("/closings", { preHandler: read }, async (request) =>
    db
      .selectFrom("cafe_closings")
      .leftJoin("users", "users.id", "cafe_closings.closed_by")
      .select([
        "cafe_closings.id",
        "cafe_closings.day",
        "cafe_closings.opening_float as openingFloat",
        "cafe_closings.expected_cash as expectedCash",
        "cafe_closings.counted_cash as countedCash",
        "cafe_closings.difference",
        "cafe_closings.comment",
        "cafe_closings.closed_at as closedAt",
        "users.full_name as closedBy",
      ])
      .where("cafe_closings.centre_id", "=", request.user!.centreId)
      .orderBy("cafe_closings.day", "desc")
      .limit(120)
      .execute(),
  );
};
