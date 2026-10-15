import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import type { Database } from "../src/db/types.js";

let dir: string;
let app: FastifyInstance;
let db: Kysely<Database>;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "gcf-web-"));
  await mkdir(path.join(dir, "assets"));
  await writeFile(path.join(dir, "index.html"), "<!doctype html><title>GCF</title>");
  await writeFile(path.join(dir, "assets", "index-abc123.js"), "console.log(1)");
  db = createDb(process.env.TEST_DATABASE_URL ?? "postgres://unused");
  const config: Config = {
    databaseUrl: "postgres://unused",
    port: 0,
    host: "127.0.0.1",
    logLevel: "silent",
    webOrigin: "https://gestion.test",
    cookieSecure: true,
    sessionIdleMinutes: 30,
    sessionAbsoluteHours: 8,
    loginMaxFailures: 5,
    loginLockMinutes: 15,
    smtp: null,
    webDistDir: dir,
  };
  app = await buildApp({ config, db, rateLimit: false, mailer: null });
});

afterAll(async () => {
  await app.close();
  await db.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe("web client serving", () => {
  it("serves fingerprinted assets with a long cache", async () => {
    const response = await app.inject({ method: "GET", url: "/assets/index-abc123.js" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("answers every client route with index.html, never cached", async () => {
    for (const url of ["/", "/eleves/0b6f7c1e-5d3a-4c2b-9f00-1a2b3c4d5e6f", "/recus"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("<title>GCF</title>");
      expect(response.headers["cache-control"]).toBe("no-cache");
    }
  });

  it("keeps unknown API routes as JSON 404", async () => {
    const response = await app.inject({ method: "GET", url: "/api/unknown" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "not_found", message: "route not found" });
  });
});
