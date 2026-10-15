import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./types.js";

const INT8_OID = 20;
const DATE_OID = 1082;

// A calendar date has no time zone: keep it as the YYYY-MM-DD string instead of a JS Date at local midnight.
pg.types.setTypeParser(DATE_OID, (value) => value);

// Amounts are integer millimes. int8 arrives as a string from node-postgres; parse it and refuse unsafe values.
pg.types.setTypeParser(INT8_OID, (value) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`int8 value ${value} exceeds the safe integer range`);
  return parsed;
});

export function createDb(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 10 }) }) });
}
