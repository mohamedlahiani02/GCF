import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../db/types.js";
import type { CafePurchasing, CafeSaleMethod, CafeStockMovementKind, CafeTicketPrinting } from "../db/types.cafe.js";
import { conflict, notFound, unprocessable } from "../errors.js";

type Db = Kysely<Database> | Transaction<Database>;

export interface CafeSettings {
  openingFloat: number;
  allowNegativeStock: boolean;
  ticketPrefix: string;
  /** Whether a ticket is printed after a sale, and on which paper. */
  ticketPrinting: CafeTicketPrinting;
  /** How stock is bought: plain deliveries, deliveries tied to a supplier, or purchase orders. */
  purchasing: CafePurchasing;
}

/** The centre's café settings; a centre that never saved them runs on the defaults of the schema. */
export async function cafeSettings(db: Db, centreId: string): Promise<CafeSettings> {
  const row = await db
    .selectFrom("cafe_settings")
    .select([
      "opening_float as openingFloat",
      "allow_negative_stock as allowNegativeStock",
      "ticket_prefix as ticketPrefix",
      "ticket_printing as ticketPrinting",
      "purchasing",
    ])
    .where("centre_id", "=", centreId)
    .executeTakeFirst();
  return row ?? { openingFloat: 0, allowNegativeStock: false, ticketPrefix: "CAF", ticketPrinting: "none", purchasing: "simple" };
}

/** Once the café till is closed for a day, that day's sales can no longer be added or cancelled. */
export async function assertCafeOpen(db: Db, centreId: string, day: string): Promise<void> {
  const closed = await db.selectFrom("cafe_closings").select("id").where("centre_id", "=", centreId).where("day", "=", day).executeTakeFirst();
  if (closed) throw conflict("cafe_closed", "the café till is closed for this day");
}

/**
 * Serialises the till of one centre for the rest of the transaction: sales, cancellations and the closing take
 * it, so a sale cannot slip into a day while that day is being closed.
 */
export async function lockCafeTill(trx: Transaction<Database>, centreId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`cafe-till:${centreId}`}, 0))`.execute(trx);
}

export interface StockChange {
  centreId: string;
  productId: string;
  kind: CafeStockMovementKind;
  /** Signed: positive adds to the stock, negative removes from it. */
  quantity: number;
  unitCost?: number | null;
  reason?: string | null;
  saleId?: string | null;
  supplierId?: string | null;
  purchaseOrderId?: string | null;
  userId: string;
  allowNegative: boolean;
}

/**
 * Applies one stock movement and returns the new quantity. The product row is locked first, so two sales of
 * the last unit cannot both succeed.
 */
export async function moveStock(trx: Transaction<Database>, change: StockChange): Promise<number> {
  const product = await trx
    .selectFrom("cafe_products")
    .select(["id", "name", "stock_quantity as stockQuantity"])
    .where("id", "=", change.productId)
    .where("centre_id", "=", change.centreId)
    .forUpdate()
    .executeTakeFirst();
  if (!product) throw notFound("product");
  const after = product.stockQuantity + change.quantity;
  if (after < 0 && !change.allowNegative) {
    throw unprocessable("insufficient_stock", `not enough stock for ${product.name}`, {
      productId: product.id,
      name: product.name,
      available: product.stockQuantity,
    });
  }
  await trx.updateTable("cafe_products").set({ stock_quantity: after, updated_at: new Date() }).where("id", "=", product.id).execute();
  await trx
    .insertInto("cafe_stock_movements")
    .values({
      centre_id: change.centreId,
      product_id: product.id,
      kind: change.kind,
      quantity: change.quantity,
      quantity_after: after,
      unit_cost: change.unitCost ?? null,
      reason: change.reason ?? null,
      sale_id: change.saleId ?? null,
      supplier_id: change.supplierId ?? null,
      purchase_order_id: change.purchaseOrderId ?? null,
      created_by: change.userId,
    })
    .execute();
  return after;
}

export async function nextSaleNumber(trx: Transaction<Database>, centreId: string, prefix: string, year: number): Promise<string> {
  const row = await trx
    .insertInto("cafe_sale_counters")
    .values({ centre_id: centreId, year, last_number: 1 })
    .onConflict((oc) => oc.columns(["centre_id", "year"]).doUpdateSet({ last_number: sql<number>`cafe_sale_counters.last_number + 1` }))
    .returning("last_number as lastNumber")
    .executeTakeFirstOrThrow();
  return `${prefix}-${year}-${String(row.lastNumber).padStart(6, "0")}`;
}

export interface CafeDay {
  day: string;
  sales: {
    id: string;
    number: string;
    soldAt: Date;
    method: CafeSaleMethod;
    total: number;
    status: "valid" | "cancelled";
    cancelReason: string | null;
    createdBy: string | null;
    lines: { productName: string; quantity: number; unitPrice: number; lineTotal: number }[];
  }[];
  totals: Record<CafeSaleMethod, number>;
  openingFloat: number;
  expectedCash: number;
}

/** The café till on a local day. Cancelled sales are listed but never counted. */
export async function cafeDay(db: Db, centreId: string, day: string, openingFloat: number): Promise<CafeDay> {
  const sales = await db
    .selectFrom("cafe_sales")
    .leftJoin("users", "users.id", "cafe_sales.created_by")
    .select([
      "cafe_sales.id",
      "cafe_sales.number",
      "cafe_sales.sold_at as soldAt",
      "cafe_sales.method",
      "cafe_sales.total",
      "cafe_sales.status",
      "cafe_sales.cancel_reason as cancelReason",
      "users.full_name as createdBy",
    ])
    .where("cafe_sales.centre_id", "=", centreId)
    .where("cafe_sales.day", "=", day)
    .orderBy("cafe_sales.sold_at")
    .execute();
  const lines = sales.length
    ? await db
        .selectFrom("cafe_sale_lines")
        .select(["sale_id as saleId", "product_name as productName", "quantity", "unit_price as unitPrice", "line_total as lineTotal"])
        .where(
          "sale_id",
          "in",
          sales.map((s) => s.id),
        )
        .orderBy("product_name")
        .execute()
    : [];
  const totals: Record<CafeSaleMethod, number> = { cash: 0, card: 0 };
  for (const s of sales) if (s.status === "valid") totals[s.method] += s.total;
  return {
    day,
    sales: sales.map((s) => ({ ...s, lines: lines.filter((l) => l.saleId === s.id).map(({ saleId: _saleId, ...line }) => line) })),
    totals,
    openingFloat,
    expectedCash: openingFloat + totals.cash,
  };
}

/** Valid café sales between two local days, both included. A sale is money received the moment it is recorded. */
export async function cafeTakings(db: Db, centreId: string, from: string, to: string): Promise<Record<CafeSaleMethod, number> & { total: number }> {
  const rows = await db
    .selectFrom("cafe_sales")
    .select(["method", sql<number>`sum(total)::bigint`.as("total")])
    .where("centre_id", "=", centreId)
    .where("status", "=", "valid")
    .where("day", ">=", from)
    .where("day", "<=", to)
    .groupBy("method")
    .execute();
  const totals = { cash: 0, card: 0 };
  for (const r of rows) totals[r.method] = Number(r.total);
  return { ...totals, total: totals.cash + totals.card };
}

/** A supplier of the centre that is still in use; an archived supplier cannot receive new deliveries or orders. */
export async function activeSupplier(db: Db, centreId: string, supplierId: string): Promise<{ id: string; name: string }> {
  const supplier = await db
    .selectFrom("cafe_suppliers")
    .select(["id", "name", "active"])
    .where("id", "=", supplierId)
    .where("centre_id", "=", centreId)
    .executeTakeFirst();
  if (!supplier) throw notFound("supplier");
  if (!supplier.active) throw unprocessable("supplier_inactive", `${supplier.name} is archived`);
  return supplier;
}

export async function nextOrderNumber(trx: Transaction<Database>, centreId: string, year: number): Promise<string> {
  const row = await trx
    .insertInto("cafe_order_counters")
    .values({ centre_id: centreId, year, last_number: 1 })
    .onConflict((oc) => oc.columns(["centre_id", "year"]).doUpdateSet({ last_number: sql<number>`cafe_order_counters.last_number + 1` }))
    .returning("last_number as lastNumber")
    .executeTakeFirstOrThrow();
  return `BC-${year}-${String(row.lastNumber).padStart(4, "0")}`;
}
