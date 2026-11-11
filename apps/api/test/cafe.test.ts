import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
let admin: string;
let secretariat: string;
let accountant: string;
let today: string;
let coffee: string;
let water: string;
let service: string;

beforeAll(async () => {
  h = await createHarness();
  await h.setModules(["training", "cafe"]);
  await h.createUser("admin", "admin@cafe.tn");
  await h.createUser("secretariat", "sec@cafe.tn");
  await h.createUser("accountant", "compta@cafe.tn");
  admin = await h.login("admin@cafe.tn");
  secretariat = await h.login("sec@cafe.tn");
  accountant = await h.login("compta@cafe.tn");
  today = (await sql<{ d: string }>`select to_char(now() at time zone 'Africa/Tunis', 'YYYY-MM-DD') as d`.execute(h.db)).rows[0]!.d;
  coffee = (await h.call("POST", "/api/cafe/products", admin, { name: "Café express", category: "Boissons chaudes", price: 2500, trackStock: false })).body.id;
  water = (await h.call("POST", "/api/cafe/products", admin, { name: "Eau 0,5 L", category: "Boissons", price: 1000, trackStock: true, lowStockThreshold: 5 }))
    .body.id;
  service = (await h.call("POST", "/api/cafe/products", admin, { name: "Croissant", price: 1800, trackStock: true })).body.id;
});

afterAll(async () => {
  await h.close();
});

async function stockOf(id: string): Promise<number> {
  const products = (await h.call("GET", "/api/cafe/products?all=true", admin)).body as { id: string; stockQuantity: number }[];
  return products.find((p) => p.id === id)!.stockQuantity;
}

describe("café catalogue and stock", () => {
  it("keeps product names unique in a centre and reserves the catalogue to managers", async () => {
    expect((await h.call("POST", "/api/cafe/products", admin, { name: "café EXPRESS", price: 3000, trackStock: false })).status).toBe(409);
    expect((await h.call("POST", "/api/cafe/products", secretariat, { name: "Thé", price: 2000, trackStock: false })).status).toBe(403);
    expect((await h.call("GET", "/api/cafe/products", secretariat)).body).toHaveLength(3);
  });

  it("receives a delivery, records a loss with a reason and corrects by a count", async () => {
    const delivery = await h.call("POST", `/api/cafe/products/${water}/stock`, admin, { kind: "purchase", quantity: 24, unitCost: 450 });
    expect(delivery.status).toBe(201);
    expect(delivery.body.stockQuantity).toBe(24);
    expect((await h.call("POST", `/api/cafe/products/${water}/stock`, admin, { kind: "loss", quantity: 2 })).status).toBe(400);
    expect(
      (await h.call("POST", `/api/cafe/products/${water}/stock`, admin, { kind: "loss", quantity: 2, reason: "Bouteilles abîmées" })).body.stockQuantity,
    ).toBe(22);
    expect((await h.call("POST", `/api/cafe/products/${water}/stock`, admin, { kind: "count", counted: 22, reason: "Inventaire" })).body.code).toBe(
      "no_difference",
    );
    const count = await h.call("POST", `/api/cafe/products/${water}/stock`, admin, { kind: "count", counted: 20, reason: "Inventaire du soir" });
    expect(count.body).toMatchObject({ quantity: -2, stockQuantity: 20 });
    const movements = (await h.call("GET", `/api/cafe/products/${water}/movements`, admin)).body as { kind: string; quantityAfter: number }[];
    expect(movements.map((m) => m.kind).sort()).toEqual(["count", "loss", "purchase"]);
  });

  it("refuses stock on a product that is not followed, and a loss larger than the stock", async () => {
    expect((await h.call("POST", `/api/cafe/products/${coffee}/stock`, admin, { kind: "purchase", quantity: 5 })).body.code).toBe("stock_not_tracked");
    expect((await h.call("POST", `/api/cafe/products/${service}/stock`, admin, { kind: "loss", quantity: 1, reason: "Tombé" })).body.code).toBe(
      "insufficient_stock",
    );
  });

  it("never lets a stock movement be rewritten", async () => {
    await expect(sql`update cafe_stock_movements set quantity = 1`.execute(h.db)).rejects.toThrow(/never changed/);
  });
});

describe("café sales", () => {
  it("prices the sale on the server, numbers the ticket and takes the products out of stock", async () => {
    const sale = await h.call("POST", "/api/cafe/sales", secretariat, {
      lines: [
        { productId: coffee, quantity: 2 },
        { productId: water, quantity: 3 },
      ],
      method: "cash",
      expectedTotal: 8000,
      cashReceived: 10000,
    });
    expect(sale.status).toBe(201);
    expect(sale.body).toMatchObject({ total: 8000, change: 2000, method: "cash", day: today });
    expect(sale.body.number).toMatch(/^CAF-\d{4}-000001$/);
    expect(await stockOf(water)).toBe(17);
    expect(await stockOf(coffee)).toBe(0);
  });

  it("refuses a sale prepared with an old price, short cash, an inactive product or missing stock", async () => {
    const line = [{ productId: coffee, quantity: 1 }];
    expect((await h.call("POST", "/api/cafe/sales", secretariat, { lines: line, method: "cash", expectedTotal: 2000 })).body.code).toBe("price_changed");
    expect((await h.call("POST", "/api/cafe/sales", secretariat, { lines: line, method: "cash", expectedTotal: 2500, cashReceived: 2000 })).body.code).toBe(
      "insufficient_cash",
    );
    expect((await h.call("POST", "/api/cafe/sales", secretariat, { lines: line, method: "card", expectedTotal: 2500, cashReceived: 2500 })).body.code).toBe(
      "cash_received_not_cash",
    );
    expect(
      (await h.call("POST", "/api/cafe/sales", secretariat, { lines: [{ productId: service, quantity: 1 }], method: "card", expectedTotal: 1800 })).body.code,
    ).toBe("insufficient_stock");
    await h.call("PATCH", `/api/cafe/products/${service}`, admin, { active: false });
    expect(
      (await h.call("POST", "/api/cafe/sales", secretariat, { lines: [{ productId: service, quantity: 1 }], method: "card", expectedTotal: 1800 })).body.code,
    ).toBe("product_inactive");
    expect((await h.call("POST", "/api/cafe/sales", secretariat, { lines: [...line, ...line], method: "cash", expectedTotal: 5000 })).status).toBe(400);
    expect(await stockOf(water)).toBe(17);
  });

  it("sells below zero only when the centre allows negative stock", async () => {
    await h.call("PATCH", `/api/cafe/products/${service}`, admin, { active: true });
    expect(
      (
        await h.call("PUT", "/api/cafe/settings", secretariat, {
          openingFloat: 0,
          allowNegativeStock: true,
          ticketPrefix: "CAF",
          ticketPrinting: "none",
          purchasing: "simple",
        })
      ).status,
    ).toBe(403);
    await h.call("PUT", "/api/cafe/settings", admin, {
      openingFloat: 50000,
      allowNegativeStock: true,
      ticketPrefix: "BAR",
      ticketPrinting: "thermal_80",
      purchasing: "simple",
    });
    const sale = await h.call("POST", "/api/cafe/sales", secretariat, { lines: [{ productId: service, quantity: 2 }], method: "card", expectedTotal: 3600 });
    expect(sale.status).toBe(201);
    expect(sale.body.number).toMatch(/^BAR-\d{4}-000002$/);
    expect(await stockOf(service)).toBe(-2);
    await h.call("PUT", "/api/cafe/settings", admin, {
      openingFloat: 50000,
      allowNegativeStock: false,
      ticketPrefix: "CAF",
      ticketPrinting: "none",
      purchasing: "simple",
    });
  });

  it("cancels a sale with a reason, puts the stock back, and only lets authorised roles do it", async () => {
    const sale = await h.call("POST", "/api/cafe/sales", secretariat, { lines: [{ productId: water, quantity: 4 }], method: "cash", expectedTotal: 4000 });
    expect(await stockOf(water)).toBe(13);
    expect((await h.call("POST", `/api/cafe/sales/${sale.body.id}/cancel`, secretariat, { reason: "Erreur" })).status).toBe(403);
    expect((await h.call("POST", `/api/cafe/sales/${sale.body.id}/cancel`, admin, {})).status).toBe(400);
    expect((await h.call("POST", `/api/cafe/sales/${sale.body.id}/cancel`, admin, { reason: "Erreur de saisie" })).status).toBe(200);
    expect((await h.call("POST", `/api/cafe/sales/${sale.body.id}/cancel`, admin, { reason: "Encore" })).body.code).toBe("already_cancelled");
    expect(await stockOf(water)).toBe(13 + 4);
  });

  it("keeps two concurrent sales from selling the same last units", async () => {
    await h.call("POST", `/api/cafe/products/${water}/stock`, admin, { kind: "count", counted: 1, reason: "Mise à zéro du test" });
    const attempt = () => h.call("POST", "/api/cafe/sales", secretariat, { lines: [{ productId: water, quantity: 1 }], method: "card", expectedTotal: 1000 });
    const results = await Promise.all([attempt(), attempt(), attempt()]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.body.code === "insufficient_stock")).toHaveLength(2);
    expect(await stockOf(water)).toBe(0);
  });
});

describe("café till", () => {
  it("shows the day with the opening float and counts only valid sales", async () => {
    const journal = (await h.call("GET", `/api/cafe/journal?date=${today}`, accountant)).body;
    expect(journal.openingFloat).toBe(50000);
    expect(journal.totals).toEqual({ cash: 8000, card: 3600 + 1000 });
    expect(journal.expectedCash).toBe(58000);
    expect(journal.sales.filter((s: { status: string }) => s.status === "cancelled")).toHaveLength(1);
    expect(journal.closing).toBeNull();
  });

  it("uses the float entered that morning instead of the usual one, and proposes it the next time", async () => {
    expect((await h.call("GET", `/api/cafe/journal?date=${today}`, admin)).body).toMatchObject({ openingRecorded: false, suggestedFloat: 50000 });
    expect((await h.call("PUT", "/api/cafe/opening", accountant, { day: today, amount: 30000 })).status).toBe(200);
    expect((await h.call("GET", `/api/cafe/journal?date=${today}`, admin)).body).toMatchObject({
      openingFloat: 30000,
      openingRecorded: true,
      expectedCash: 38000,
    });
    expect((await h.call("PUT", "/api/cafe/opening", secretariat, { day: "2999-01-01", amount: 1 })).body.code).toBe("future_day");
    expect((await h.call("PUT", "/api/cafe/opening", secretariat, { day: today, amount: 50000 })).body.amount).toBe(50000);
  });

  it("closes the day once, asks for a comment on a difference, then refuses sales and cancellations", async () => {
    expect((await h.call("POST", "/api/cafe/closings", secretariat, { day: today, countedCash: 58000 })).status).toBe(403);
    expect((await h.call("POST", "/api/cafe/closings", accountant, { day: today, countedCash: 57000 })).body.code).toBe("comment_required");
    const closing = await h.call("POST", "/api/cafe/closings", accountant, { day: today, countedCash: 57000, comment: "Un dinar manquant" });
    expect(closing.status).toBe(201);
    expect(closing.body).toMatchObject({ openingFloat: 50000, expectedCash: 58000, countedCash: 57000, difference: -1000 });
    expect((await h.call("POST", "/api/cafe/closings", accountant, { day: today, countedCash: 58000 })).body.code).toBe("already_closed");
    const sale = await h.call("POST", "/api/cafe/sales", secretariat, { lines: [{ productId: coffee, quantity: 1 }], method: "cash", expectedTotal: 2500 });
    expect(sale.body.code).toBe("cafe_closed");
    const first = (await h.call("GET", `/api/cafe/journal?date=${today}`, admin)).body.sales[0];
    expect((await h.call("POST", `/api/cafe/sales/${first.id}/cancel`, admin, { reason: "Trop tard" })).body.code).toBe("cafe_closed");
    expect((await h.call("PUT", "/api/cafe/opening", admin, { day: today, amount: 1000 })).body.code).toBe("cafe_closed");
    await expect(sql`delete from cafe_closings`.execute(h.db)).rejects.toThrow(/locked/);
  });

  it("writes every operation to the audit log and keeps the centre's cash journal untouched", async () => {
    const actions = (await h.db.selectFrom("audit_log").select("action").where("action", "like", "cafe.%").execute()).map((r) => r.action);
    expect(new Set(actions)).toEqual(
      new Set([
        "cafe.product_created",
        "cafe.product_updated",
        "cafe.stock_purchase",
        "cafe.stock_loss",
        "cafe.stock_count",
        "cafe.settings_changed",
        "cafe.sale_recorded",
        "cafe.sale_cancelled",
        "cafe.closed",
      ]),
    );
    const cash = (await h.call("GET", `/api/cash/journal?date=${today}`, admin)).body;
    expect(cash.expectedCash).toBe(0);
  });
});

describe("café takings in the centre's figures", () => {
  const range = () => `from=${today}&to=${today}`;

  it("adds the café to the revenue report and keeps its till apart in the collections report", async () => {
    const revenue = (await h.call("GET", `/api/reports/revenue?${range()}`, accountant)).body;
    expect(revenue.rows).toContainEqual({ offer: "Café : ventes au comptoir", invoiced: 12600, collected: 12600 });
    const collections = (await h.call("GET", `/api/reports/collections?${range()}`, accountant)).body;
    const cafe = collections.rows.filter((r: { till: string }) => r.till === "Café");
    expect(cafe.reduce((sum: number, r: { total: number }) => sum + r.total, 0)).toBe(12600);
    expect(collections.rows.filter((r: { till: string }) => r.till === "Centre")).toHaveLength(0);
  });

  it("reports the sales per product without the cancelled sale", async () => {
    const report = (await h.call("GET", `/api/reports/cafe?${range()}`, accountant)).body;
    expect(report.rows).toEqual([
      { product: "Café express", quantity: 2, total: 5000 },
      { product: "Eau 0,5 L", quantity: 4, total: 4000 },
      { product: "Croissant", quantity: 2, total: 3600 },
    ]);
    expect((await h.call("GET", "/api/reports", accountant)).body.map((r: { name: string }) => r.name)).toContain("cafe");
  });

  it("counts the café in the dashboard takings and gives its share", async () => {
    const dashboard = (await h.call("GET", "/api/dashboard", accountant)).body;
    expect(dashboard.financial).toMatchObject({ collectionsToday: 12600, collectionsMonth: 12600, cafeToday: 12600, cafeMonth: 12600 });
    expect(dashboard.financial.series.at(-1).total).toBe(12600);
  });
});

describe("café purchasing, as each centre works", () => {
  const settings = (purchasing: string) =>
    h.call("PUT", "/api/cafe/settings", admin, { openingFloat: 50000, allowNegativeStock: false, ticketPrefix: "CAF", ticketPrinting: "none", purchasing });
  let supplier: string;

  it("asks for a supplier on a delivery once the centre follows its suppliers", async () => {
    await settings("suppliers");
    expect((await h.call("POST", `/api/cafe/products/${water}/stock`, admin, { kind: "purchase", quantity: 6 })).body.code).toBe("supplier_required");
    expect((await h.call("POST", "/api/cafe/suppliers", secretariat, { name: "Eaux du Nord" })).status).toBe(403);
    supplier = (await h.call("POST", "/api/cafe/suppliers", admin, { name: "Eaux du Nord", phone: "71 000 000" })).body.id;
    expect((await h.call("POST", "/api/cafe/suppliers", admin, { name: "eaux du nord" })).status).toBe(409);
    const delivery = await h.call("POST", `/api/cafe/products/${water}/stock`, admin, { kind: "purchase", quantity: 6, unitCost: 400, supplierId: supplier });
    expect(delivery.body.stockQuantity).toBe(6);
    const movements = (await h.call("GET", `/api/cafe/products/${water}/movements`, admin)).body;
    expect(movements[0]).toMatchObject({ kind: "purchase", supplierName: "Eaux du Nord", orderNumber: null });
  });

  it("refuses purchase orders until the centre chooses them, then receives stock only through an order", async () => {
    const lines = [{ productId: water, quantity: 24, unitCost: 380 }];
    expect((await h.call("POST", "/api/cafe/purchase-orders", admin, { supplierId: supplier, lines })).body.code).toBe("orders_disabled");
    await settings("orders");
    expect((await h.call("POST", `/api/cafe/products/${water}/stock`, admin, { kind: "purchase", quantity: 1, supplierId: supplier })).body.code).toBe(
      "order_required",
    );
    const untracked = await h.call("POST", "/api/cafe/purchase-orders", admin, {
      supplierId: supplier,
      lines: [{ productId: coffee, quantity: 1, unitCost: 100 }],
    });
    expect(untracked.body.code).toBe("stock_not_tracked");
    const order = await h.call("POST", "/api/cafe/purchase-orders", admin, { supplierId: supplier, lines });
    expect(order.body).toMatchObject({ status: "draft", total: 9120 });
    expect(order.body.number).toMatch(/^BC-\d{4}-0001$/);
    expect((await h.call("POST", `/api/cafe/purchase-orders/${order.body.id}/receive`, admin)).body.code).toBe("order_not_sent");
    expect(await stockOf(water)).toBe(6);
    expect((await h.call("POST", `/api/cafe/purchase-orders/${order.body.id}/send`, admin)).body.status).toBe("ordered");
    expect((await h.call("POST", `/api/cafe/purchase-orders/${order.body.id}/receive`, admin)).body.status).toBe("received");
    expect(await stockOf(water)).toBe(30);
    expect((await h.call("POST", `/api/cafe/purchase-orders/${order.body.id}/receive`, admin)).body.code).toBe("order_not_sent");
    expect((await h.call("POST", `/api/cafe/purchase-orders/${order.body.id}/cancel`, admin, { reason: "Erreur" })).body.code).toBe("order_closed");
    const movements = (await h.call("GET", `/api/cafe/products/${water}/movements`, admin)).body;
    expect(movements[0]).toMatchObject({ kind: "purchase", quantity: 24, unitCost: 380, supplierName: "Eaux du Nord", orderNumber: order.body.number });
  });

  it("cancels an order that was not received, and stops ordering from an archived supplier", async () => {
    const order = await h.call("POST", "/api/cafe/purchase-orders", admin, { supplierId: supplier, lines: [{ productId: water, quantity: 5, unitCost: 380 }] });
    expect((await h.call("POST", `/api/cafe/purchase-orders/${order.body.id}/cancel`, admin, { reason: "Commande en double" })).body.status).toBe("cancelled");
    expect(await stockOf(water)).toBe(30);
    await h.call("PATCH", `/api/cafe/suppliers/${supplier}`, admin, { active: false });
    const refused = await h.call("POST", "/api/cafe/purchase-orders", admin, {
      supplierId: supplier,
      lines: [{ productId: water, quantity: 5, unitCost: 380 }],
    });
    expect(refused.body.code).toBe("supplier_inactive");
    const list = (await h.call("GET", "/api/cafe/purchase-orders", accountant)).body;
    expect(list.map((o: { status: string }) => o.status).sort()).toEqual(["cancelled", "received"]);
    expect(list[0].lines).toHaveLength(1);
  });
});

describe("café module", () => {
  it("is closed to a centre that did not subscribe to it", async () => {
    await h.setModules(["training"]);
    const again = await h.login("admin@cafe.tn");
    expect((await h.call("GET", "/api/cafe/products", again)).status).toBe(403);
    expect((await h.call("GET", `/api/reports/cafe?from=${today}&to=${today}`, again)).status).toBe(403);
    expect((await h.call("GET", "/api/reports", again)).body.map((r: { name: string }) => r.name)).not.toContain("cafe");
  });

  it("keeps each user's shortcuts in their order, on their account", async () => {
    const again = await h.login("admin@cafe.tn");
    expect((await h.call("GET", "/api/auth/session", again)).body.shortcuts).toBeNull();
    expect((await h.call("PUT", "/api/auth/shortcuts", again, { ids: ["collect", "enrol", "collect"] })).status).toBe(400);
    expect((await h.call("PUT", "/api/auth/shortcuts", again, { ids: ["planning", "collect"] })).status).toBe(200);
    expect((await h.call("GET", "/api/auth/session", again)).body.shortcuts).toEqual(["planning", "collect"]);
    expect((await h.call("GET", "/api/auth/session", await h.login("sec@cafe.tn"))).body.shortcuts).toBeNull();
    expect((await h.call("PUT", "/api/auth/shortcuts", again, { ids: null })).body.shortcuts).toBeNull();
  });
});
