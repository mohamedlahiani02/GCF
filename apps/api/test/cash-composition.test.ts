import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
let admin: string;
let accountant: string;
let today: string;
let coffee: string;

const settings = (tillMode: "separate" | "single") =>
  h.call("PUT", "/api/cafe/settings", admin, {
    openingFloat: 0,
    allowNegativeStock: false,
    ticketPrefix: "CAF",
    ticketPrinting: "none",
    purchasing: "simple",
    tillMode,
  });
const sell = () => h.call("POST", "/api/cafe/sales", admin, { lines: [{ productId: coffee, quantity: 1 }], method: "cash", expectedTotal: 2500 });

beforeAll(async () => {
  h = await createHarness();
  await h.setModules(["training", "cafe"]);
  await h.createUser("admin", "admin@caisse.tn");
  await h.createUser("accountant", "compta@caisse.tn");
  admin = await h.login("admin@caisse.tn");
  accountant = await h.login("compta@caisse.tn");
  today = (await sql<{ d: string }>`select to_char(now() at time zone 'Africa/Tunis', 'YYYY-MM-DD') as d`.execute(h.db)).rows[0]!.d;
  coffee = (await h.call("POST", "/api/cafe/products", admin, { name: "Café express", price: 2500, trackStock: false })).body.id;
});

afterAll(async () => {
  await h.close();
});

describe("composition of the centre's till", () => {
  it("shows the café apart in a separate till, without counting it in the expected cash", async () => {
    expect((await sell()).status).toBe(201);
    const journal = (await h.call("GET", `/api/cash/journal?date=${today}`, admin)).body;
    expect(journal.cafe).toMatchObject({ mode: "separate", cash: 2500, card: 0, total: 2500, closed: false });
    expect(journal.expectedCash).toBe(0);
  });

  it("counts the café in a single till and leaves its closing to the centre", async () => {
    expect((await settings("single")).status).toBe(200);
    const journal = (await h.call("GET", `/api/cash/journal?date=${today}`, admin)).body;
    expect(journal.cafe.mode).toBe("single");
    expect(journal.totals.cash).toBe(2500);
    expect(journal.expectedCash).toBe(2500);
    expect((await h.call("POST", "/api/cafe/closings", accountant, { day: today, countedCash: 2500 })).body.code).toBe("single_till");
    expect((await h.call("PUT", "/api/cafe/opening", admin, { day: today, amount: 1000 })).body.code).toBe("single_till");
  });

  it("closes the café's sales with the centre's day", async () => {
    const closing = await h.call("POST", "/api/cash/closings", accountant, { day: today, countedCash: 2500 });
    expect(closing.status).toBe(201);
    expect(closing.body).toMatchObject({ expectedCash: 2500, difference: 0 });
    expect((await sell()).body.code).toBe("cafe_closed");
  });
});
