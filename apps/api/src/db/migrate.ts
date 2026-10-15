import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql, type Kysely } from "kysely";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";
import type { Database } from "./types.js";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/** Plain SQL migrations, applied in file-name order, each inside the migrator's transaction. */
class SqlFileProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      const content = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      migrations[file.replace(/\.sql$/, "")] = {
        up: async (db) => {
          await sql.raw(content).execute(db);
        },
      };
    }
    return migrations;
  }
}

export async function migrateToLatest(db: Kysely<Database>): Promise<string[]> {
  const migrator = new Migrator({ db, provider: new SqlFileProvider() });
  const { error, results } = await migrator.migrateToLatest();
  const failed = results?.find((r) => r.status === "Error");
  if (error || failed) {
    throw new Error(`migration failed: ${failed?.migrationName ?? "unknown"}`, { cause: error });
  }
  return (results ?? []).filter((r) => r.status === "Success").map((r) => r.migrationName);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { loadConfig } = await import("../config.js");
  const { createDb } = await import("./client.js");
  const db = createDb(loadConfig().databaseUrl);
  try {
    const applied = await migrateToLatest(db);
    console.log(applied.length ? `applied: ${applied.join(", ")}` : "database is up to date");
  } finally {
    await db.destroy();
  }
}
