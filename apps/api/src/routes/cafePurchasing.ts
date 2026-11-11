import type { FastifyPluginAsync } from "fastify";
import type { Transaction } from "kysely";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { Database } from "../db/types.js";
import { activeSupplier, cafeSettings, moveStock, nextOrderNumber } from "../domain/cafe.js";
import { centreClock } from "../domain/ledger.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { idParam, millimes, optionalEmail, optionalText, reason, requiredText, uuid } from "../validation.js";

const supplierBody = z.object({ name: requiredText(120), phone: optionalText(40), email: optionalEmail, note: optionalText(500) }).strict();
const supplierPatch = supplierBody.partial().extend({ active: z.boolean().optional() }).strict();
const orderBody = z
  .object({
    supplierId: uuid,
    note: optionalText(500),
    lines: z
      .array(z.object({ productId: uuid, quantity: z.number().int().min(1).max(100_000), unitCost: millimes }).strict())
      .min(1)
      .max(100)
      .refine((lines) => new Set(lines.map((l) => l.productId)).size === lines.length, "a product appears once per order"),
  })
  .strict();
const cancelBody = z.object({ reason }).strict();

const supplierColumns = ["id", "name", "phone", "email", "note", "active"] as const;

/** Suppliers and purchase orders of the café. Which of them a centre uses is its `purchasing` setting. */
export const cafePurchasingRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const read = app.requirePermission("cafe:read");
  const manage = app.requirePermission("cafe:manage");

  app.get("/suppliers", { preHandler: read }, async (request) =>
    db.selectFrom("cafe_suppliers").select(supplierColumns).where("centre_id", "=", request.user!.centreId).orderBy("active", "desc").orderBy("name").execute(),
  );

  app.post("/suppliers", { preHandler: manage }, async (request, reply) => {
    const actor = request.user!;
    const body = supplierBody.parse(request.body);
    const supplier = await db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto("cafe_suppliers")
        .values({ centre_id: actor.centreId, name: body.name, phone: body.phone ?? null, email: body.email ?? null, note: body.note ?? null })
        .returning(supplierColumns)
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "cafe.supplier_created",
        objectType: "cafe_supplier",
        objectId: created.id,
        after: created,
      });
      return created;
    });
    return reply.status(201).send(supplier);
  });

  app.patch("/suppliers/:id", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = supplierPatch.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom("cafe_suppliers")
        .select(supplierColumns)
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw notFound("supplier");
      const after = await trx
        .updateTable("cafe_suppliers")
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.phone !== undefined ? { phone: body.phone } : {}),
          ...(body.email !== undefined ? { email: body.email } : {}),
          ...(body.note !== undefined ? { note: body.note } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .returning(supplierColumns)
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "cafe.supplier_updated",
        objectType: "cafe_supplier",
        objectId: id,
        before,
        after,
      });
      return after;
    });
  });

  app.get("/purchase-orders", { preHandler: read }, async (request) => {
    const centreId = request.user!.centreId;
    const orders = await db
      .selectFrom("cafe_purchase_orders")
      .innerJoin("cafe_suppliers", "cafe_suppliers.id", "cafe_purchase_orders.supplier_id")
      .leftJoin("users", "users.id", "cafe_purchase_orders.created_by")
      .select([
        "cafe_purchase_orders.id",
        "cafe_purchase_orders.number",
        "cafe_purchase_orders.status",
        "cafe_purchase_orders.note",
        "cafe_purchase_orders.total",
        "cafe_purchase_orders.created_at as createdAt",
        "cafe_purchase_orders.ordered_at as orderedAt",
        "cafe_purchase_orders.received_at as receivedAt",
        "cafe_purchase_orders.cancel_reason as cancelReason",
        "cafe_suppliers.name as supplierName",
        "users.full_name as createdBy",
      ])
      .where("cafe_purchase_orders.centre_id", "=", centreId)
      .orderBy("cafe_purchase_orders.created_at", "desc")
      .limit(100)
      .execute();
    const lines = orders.length
      ? await db
          .selectFrom("cafe_purchase_order_lines")
          .select(["order_id as orderId", "product_name as productName", "quantity", "unit_cost as unitCost"])
          .where(
            "order_id",
            "in",
            orders.map((o) => o.id),
          )
          .orderBy("product_name")
          .execute()
      : [];
    return orders.map((o) => ({ ...o, lines: lines.filter((l) => l.orderId === o.id).map(({ orderId: _orderId, ...line }) => line) }));
  });

  /** A draft order: what to buy, from whom, at which unit cost. Nothing moves in stock until it is received. */
  app.post("/purchase-orders", { preHandler: manage }, async (request, reply) => {
    const actor = request.user!;
    const body = orderBody.parse(request.body);
    const order = await db.transaction().execute(async (trx) => {
      if ((await cafeSettings(trx, actor.centreId)).purchasing !== "orders") throw unprocessable("orders_disabled", "this centre does not use purchase orders");
      const supplier = await activeSupplier(trx, actor.centreId, body.supplierId);
      const products = await trx
        .selectFrom("cafe_products")
        .select(["id", "name", "track_stock as trackStock"])
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
        if (!product.trackStock) throw unprocessable("stock_not_tracked", `${product.name} has no stock to follow`, { productId: product.id });
        return { ...line, productName: product.name };
      });
      const { today } = await centreClock(trx, actor.centreId);
      const number = await nextOrderNumber(trx, actor.centreId, Number(today.slice(0, 4)));
      const total = lines.reduce((sum, l) => sum + l.quantity * l.unitCost, 0);
      const created = await trx
        .insertInto("cafe_purchase_orders")
        .values({ centre_id: actor.centreId, number, supplier_id: supplier.id, note: body.note ?? null, total, created_by: actor.userId })
        .returning(["id", "number", "status", "total"])
        .executeTakeFirstOrThrow();
      await trx
        .insertInto("cafe_purchase_order_lines")
        .values(lines.map((l) => ({ order_id: created.id, product_id: l.productId, product_name: l.productName, quantity: l.quantity, unit_cost: l.unitCost })))
        .execute();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "cafe.order_created",
        objectType: "cafe_purchase_order",
        objectId: created.id,
        after: { ...created, supplier: supplier.name, lines },
      });
      return created;
    });
    return reply.status(201).send(order);
  });

  async function lockOrder(trx: Transaction<Database>, centreId: string, id: string) {
    const order = await trx
      .selectFrom("cafe_purchase_orders")
      .select(["id", "number", "status", "supplier_id as supplierId"])
      .where("id", "=", id)
      .where("centre_id", "=", centreId)
      .forUpdate()
      .executeTakeFirst();
    if (!order) throw notFound("purchase order");
    return order;
  }

  app.post("/purchase-orders/:id/send", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    return db.transaction().execute(async (trx) => {
      const order = await lockOrder(trx, actor.centreId, id);
      if (order.status !== "draft") throw conflict("order_not_draft", "only a draft order can be sent");
      await trx.updateTable("cafe_purchase_orders").set({ status: "ordered", ordered_at: new Date() }).where("id", "=", id).execute();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "cafe.order_sent",
        objectType: "cafe_purchase_order",
        objectId: id,
        before: { status: "draft" },
        after: { status: "ordered" },
      });
      return { id, number: order.number, status: "ordered" as const };
    });
  });

  /** Receives the whole order: each line enters the stock at its unit cost, tied to the order and its supplier. */
  app.post("/purchase-orders/:id/receive", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    return db.transaction().execute(async (trx) => {
      const order = await lockOrder(trx, actor.centreId, id);
      if (order.status !== "ordered") throw conflict("order_not_sent", "only a sent order can be received");
      const lines = await trx
        .selectFrom("cafe_purchase_order_lines")
        .select(["product_id as productId", "quantity", "unit_cost as unitCost"])
        .where("order_id", "=", id)
        .orderBy("product_id")
        .execute();
      for (const line of lines) {
        await moveStock(trx, {
          centreId: actor.centreId,
          productId: line.productId,
          kind: "purchase",
          quantity: line.quantity,
          unitCost: line.unitCost,
          supplierId: order.supplierId,
          purchaseOrderId: id,
          userId: actor.userId,
          allowNegative: true,
        });
      }
      await trx
        .updateTable("cafe_purchase_orders")
        .set({ status: "received", received_at: new Date(), received_by: actor.userId })
        .where("id", "=", id)
        .execute();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "cafe.order_received",
        objectType: "cafe_purchase_order",
        objectId: id,
        before: { status: "ordered" },
        after: { status: "received", lines },
      });
      return { id, number: order.number, status: "received" as const };
    });
  });

  app.post("/purchase-orders/:id/cancel", { preHandler: manage }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = cancelBody.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const order = await lockOrder(trx, actor.centreId, id);
      if (order.status !== "draft" && order.status !== "ordered") throw conflict("order_closed", "a received or cancelled order cannot be cancelled");
      await trx
        .updateTable("cafe_purchase_orders")
        .set({ status: "cancelled", cancelled_at: new Date(), cancel_reason: body.reason })
        .where("id", "=", id)
        .execute();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "cafe.order_cancelled",
        objectType: "cafe_purchase_order",
        objectId: id,
        before: { status: order.status },
        after: { status: "cancelled" },
        reason: body.reason,
      });
      return { id, number: order.number, status: "cancelled" as const };
    });
  });
};
