import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/passwords.js";
import type { Config } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { migrateToLatest } from "../src/db/migrate.js";
import type { Database, Role } from "../src/db/types.js";
import type { Mailer, OutgoingMail } from "../src/mail.js";

export const ORIGIN = "https://gestion.test";
export const PASSWORD = "correct-horse-battery";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

export interface Harness {
  app: FastifyInstance;
  db: Kysely<Database>;
  centreId: string;
  createUser(role: Role, email: string): Promise<string>;
  login(email: string, password?: string): Promise<string>;
  call(method: "GET" | "POST" | "PATCH" | "PUT", url: string, cookie: string, payload?: unknown): Promise<{ status: number; body: any }>;
  close(): Promise<void>;
}

/** Records outgoing mail instead of talking to an SMTP server. */
export class RecordingMailer implements Mailer {
  readonly sent: OutgoingMail[] = [];
  failNext = false;
  async send(mail: OutgoingMail): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("SMTP connection refused");
    }
    this.sent.push(mail);
  }
}

export async function createHarness(options: { mailer?: Mailer } = {}): Promise<Harness> {
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL database");
  const db = createDb(testDatabaseUrl);
  await sql`drop schema if exists public cascade`.execute(db);
  await sql`create schema public`.execute(db);
  await migrateToLatest(db);

  const centre = await db.insertInto("centres").values({ name: "Centre de test" }).returning("id").executeTakeFirstOrThrow();
  const config: Config = {
    databaseUrl: testDatabaseUrl,
    port: 0,
    host: "127.0.0.1",
    logLevel: "silent",
    webOrigin: ORIGIN,
    cookieSecure: true,
    sessionIdleMinutes: 30,
    sessionAbsoluteHours: 8,
    loginMaxFailures: 5,
    loginLockMinutes: 15,
    smtp: null,
    webDistDir: null,
  };
  const app = await buildApp({ config, db, rateLimit: false, mailer: options.mailer ?? null });
  const hash = await hashPassword(PASSWORD);

  return {
    app,
    db,
    centreId: centre.id,
    async createUser(role, email) {
      const user = await db
        .insertInto("users")
        .values({ centre_id: centre.id, email, full_name: `${role} user`, role, password_hash: hash })
        .returning("id")
        .executeTakeFirstOrThrow();
      return user.id;
    },
    async login(email, password = PASSWORD) {
      const response = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: ORIGIN }, payload: { email, password } });
      if (response.statusCode !== 200) throw new Error(`login failed: ${response.statusCode} ${response.body}`);
      const cookie = response.cookies.find((c) => c.name === "gcf_session");
      if (!cookie) throw new Error("no session cookie");
      return `gcf_session=${cookie.value}`;
    },
    async call(method, url, cookie, payload) {
      const response = await app.inject({
        method,
        url,
        headers: method === "GET" ? { cookie } : { cookie, origin: ORIGIN },
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });
      return { status: response.statusCode, body: response.body ? response.json() : undefined };
    },
    async close() {
      await app.close();
      await db.destroy();
    },
  };
}
