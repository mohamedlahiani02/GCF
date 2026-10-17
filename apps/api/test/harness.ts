import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/passwords.js";
import type { Config } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { migrateToLatest } from "../src/db/migrate.js";
import type { Database, Module, Role } from "../src/db/types.js";
import type { Mailer, OutgoingMail } from "../src/mail.js";

export const ORIGIN = "https://gestion.test";
export const PUBLIC_ORIGIN = "https://www.cowork.test";
export const PASSWORD = "correct-horse-battery";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

export interface Harness {
  app: FastifyInstance;
  db: Kysely<Database>;
  centreId: string;
  createUser(role: Role, email: string): Promise<string>;
  login(email: string, password?: string): Promise<string>;
  call(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, cookie: string, payload?: unknown): Promise<{ status: number; body: any }>;
  /** Enables exactly these modules for the test centre; staff must log in again to see new permissions. */
  setModules(modules: Module[]): Promise<void>;
  /** A JSON call from the public origin (portal and website forms), with an optional member cookie. */
  callPublic(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    cookie?: string,
    payload?: unknown,
  ): Promise<{ status: number; body: any; headers: Record<string, unknown>; cookies: { name: string; value: string }[] }>;
  /** A raw GET on the public host (website pages, sitemap, media). */
  getPublic(url: string): Promise<{ status: number; body: string; headers: Record<string, unknown> }>;
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
    publicOrigin: PUBLIC_ORIGIN,
    portalDistDir: null,
    memberSessionIdleMinutes: 10080,
    memberSessionAbsoluteHours: 720,
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
    async setModules(modules) {
      await db.updateTable("centres").set({ modules }).where("id", "=", centre.id).execute();
    },
    async callPublic(method, url, cookie, payload) {
      const host = new URL(PUBLIC_ORIGIN).host;
      const headers: Record<string, string> = { host, ...(cookie ? { cookie } : {}), ...(method === "GET" ? {} : { origin: PUBLIC_ORIGIN }) };
      const response = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
      const text = response.body;
      return {
        status: response.statusCode,
        body: text && response.headers["content-type"]?.toString().includes("application/json") ? response.json() : text,
        headers: response.headers,
        cookies: response.cookies.map((c) => ({ name: c.name, value: c.value })),
      };
    },
    async getPublic(url) {
      const response = await app.inject({ method: "GET", url, headers: { host: new URL(PUBLIC_ORIGIN).host } });
      return { status: response.statusCode, body: response.body, headers: response.headers };
    },
    async close() {
      await app.close();
      await db.destroy();
    },
  };
}
