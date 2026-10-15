import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Browser origin allowed to call state-changing endpoints (CSRF defence in addition to SameSite=Strict). */
  WEB_ORIGIN: z.string().url(),
  COOKIE_SECURE: z.enum(["true", "false"]).default("true"),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).default(30),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).default(8),
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
  SMTP_SECURE: z.enum(["true", "false"]).default("true"),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().min(3).optional(),
});

export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  webOrigin: string;
  cookieSecure: boolean;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  loginMaxFailures: number;
  loginLockMinutes: number;
  smtp: { host: string; port: number; secure: boolean; user: string | undefined; pass: string | undefined; from: string } | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty variable means "not set" (a blank line in a .env file must not fail validation).
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  if (e.SMTP_HOST && !e.MAIL_FROM) throw new Error("invalid configuration: MAIL_FROM is required when SMTP_HOST is set");
  return {
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    webOrigin: new URL(e.WEB_ORIGIN).origin,
    cookieSecure: e.COOKIE_SECURE === "true",
    sessionIdleMinutes: e.SESSION_IDLE_MINUTES,
    sessionAbsoluteHours: e.SESSION_ABSOLUTE_HOURS,
    loginMaxFailures: e.LOGIN_MAX_FAILURES,
    loginLockMinutes: e.LOGIN_LOCK_MINUTES,
    smtp: e.SMTP_HOST
      ? { host: e.SMTP_HOST, port: e.SMTP_PORT, secure: e.SMTP_SECURE === "true", user: e.SMTP_USER, pass: e.SMTP_PASS, from: e.MAIL_FROM! }
      : null,
  };
}
