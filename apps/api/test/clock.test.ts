import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_NOW } from "./clock.js";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

describe("test clock", () => {
  it("runs the application and the database at the same fixed date", async () => {
    const appNow = Date.now();
    const row = (await sql<{ now: Date; today: string }>`select now() as now, to_char(now() at time zone 'Africa/Tunis', 'YYYY-MM-DD') as today`.execute(h.db))
      .rows[0]!;
    expect(row.today).toBe("2026-10-20");
    // Both clocks start from the same moment and move at the same pace; allow for the time the suite has run.
    expect(Math.abs(row.now.getTime() - appNow)).toBeLessThan(5_000);
    expect(appNow - TEST_NOW.getTime()).toBeGreaterThanOrEqual(0);
    expect(appNow - TEST_NOW.getTime()).toBeLessThan(15 * 60_000);
  });

  it("stamps column defaults with the test clock too", async () => {
    const student = await h.db
      .insertInto("students")
      .values({ centre_id: h.centreId, first_name: "Horloge", last_name: "Test" })
      .returning("created_at")
      .executeTakeFirstOrThrow();
    expect(student.created_at.toISOString().slice(0, 10)).toBe("2026-10-20");
  });
});
