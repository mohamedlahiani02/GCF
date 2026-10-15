/**
 * Creates the centre and its first administrator on an empty database.
 * Usage: pnpm --filter @gcf/api bootstrap -- --centre "Centre name" --email admin@example.tn --name "Full Name"
 * The password is typed on the terminal (hidden) and never passed on the command line.
 */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { hashPassword, PASSWORD_MIN_LENGTH } from "../auth/passwords.js";
import { writeAudit } from "../audit.js";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { migrateToLatest } from "../db/migrate.js";

async function readHiddenLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("a terminal is required to type the password");
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write(prompt);
  muted = true;
  const answer = await new Promise<string>((resolve) => rl.question("", resolve));
  rl.close();
  process.stdout.write("\n");
  return answer;
}

const { values } = parseArgs({
  options: { centre: { type: "string" }, email: { type: "string" }, name: { type: "string" } },
});
if (!values.centre || !values.email || !values.name) {
  console.error('usage: bootstrap --centre "Centre name" --email admin@example.tn --name "Full Name"');
  process.exit(2);
}

const db = createDb(loadConfig().databaseUrl);
try {
  await migrateToLatest(db);
  const existing = await db.selectFrom("centres").select("id").executeTakeFirst();
  if (existing) throw new Error("a centre already exists: bootstrap only runs on an empty database");
  const password = await readHiddenLine(`Password for ${values.email} (min ${PASSWORD_MIN_LENGTH} characters): `);
  const confirmation = await readHiddenLine("Confirm password: ");
  if (password !== confirmation) throw new Error("passwords do not match");
  const hash = await hashPassword(password);
  await db.transaction().execute(async (trx) => {
    const centre = await trx.insertInto("centres").values({ name: values.centre!.trim() }).returning("id").executeTakeFirstOrThrow();
    const admin = await trx
      .insertInto("users")
      .values({ centre_id: centre.id, email: values.email!.trim().toLowerCase(), full_name: values.name!.trim(), role: "admin", password_hash: hash })
      .returning("id")
      .executeTakeFirstOrThrow();
    await writeAudit(trx, { centreId: centre.id, userId: admin.id, action: "centre.bootstrapped", objectType: "centre", objectId: centre.id });
  });
  console.log("centre and administrator created");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
