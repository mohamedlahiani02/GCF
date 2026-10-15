import { isIsoDate } from "@gcf/shared";
import { z } from "zod";

export const uuid = z.string().uuid();
export const idParam = z.object({ id: uuid });
export const requiredText = (max: number) => z.string().trim().min(1).max(max);
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();
export const optionalEmail = z
  .union([z.literal(""), z.string().trim().toLowerCase().email().max(254)])
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional();
export const isoDate = z.string().refine(isIsoDate, "expected a valid YYYY-MM-DD date");
/** An amount in millimes: a non-negative safe integer. */
export const millimes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const basisPoints = z.number().int().min(1).max(10_000);
export const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");
export const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "expected YYYY-MM");
export const reason = z.string().trim().min(1).max(500);
export const archiveBody = z.object({ reason }).strict();

/** "14:00:00" from PostgreSQL, "14:00" from clients: compare and display as HH:MM. */
export function toClock(value: string): string {
  return value.slice(0, 5);
}
