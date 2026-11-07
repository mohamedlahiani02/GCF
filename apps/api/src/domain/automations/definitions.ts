import type { AutomationSchedule } from "@gcf/shared";
import { z } from "zod";
import type { Permission } from "../../auth/permissions.js";
import type { AutomationKey, AutomationMode, Module } from "../../db/types.js";

const hour = z.number().int().min(0).max(23);
const staffRoles = z
  .array(z.enum(["admin", "secretariat", "accountant", "editor"]))
  .max(4)
  .refine((list) => new Set(list).size === list.length, "each role may only be listed once");

export const reminderParams = z
  .object({
    /** ISO weekday of the weekly run (Monday = 1). */
    weekday: z.number().int().min(1).max(7).default(1),
    hour: hour.default(9),
    /** A student reminded less than this many days ago is left out. */
    minDaysBetween: z.number().int().min(1).max(90).default(7),
    /** Students who owe less than this (millimes) are left out. */
    minAmount: z.number().int().min(0).max(1_000_000_000).default(0),
  })
  .strict();

export const payrollParams = z
  .object({
    /** Day of the month on which the previous month is calculated. */
    day: z.number().int().min(1).max(28).default(2),
    hour: hour.default(7),
    /** Staff roles that receive the summary by e-mail. */
    notifyRoles: staffRoles.default(["admin", "accountant"]),
  })
  .strict();

export const digestParams = z
  .object({
    hour: hour.default(18),
    roles: staffRoles.min(1).default(["admin", "secretariat"]),
  })
  .strict();

export const mailNoticeParams = z.object({}).strict();

export interface AutomationDefinition {
  modes: readonly AutomationMode[];
  /** The module the automation belongs to; null when it belongs to the core. */
  module: Module | null;
  params: z.ZodType<Record<string, unknown>>;
  /** When it runs; null for an automation triggered by an event instead of the clock. */
  schedule: ((params: Record<string, unknown>) => AutomationSchedule) | null;
}

export const AUTOMATIONS: Record<AutomationKey, AutomationDefinition> = {
  overdue_reminders: {
    modes: ["off", "propose", "auto"],
    module: "training",
    params: reminderParams,
    schedule: (p) => ({ kind: "weekly", weekday: p.weekday as number, hour: p.hour as number }),
  },
  payroll_month: {
    modes: ["off", "propose", "auto"],
    module: "training",
    params: payrollParams,
    schedule: (p) => ({ kind: "monthly", day: p.day as number, hour: p.hour as number }),
  },
  daily_digest: {
    modes: ["off", "auto"],
    module: null,
    params: digestParams,
    schedule: (p) => ({ kind: "daily", hour: p.hour as number }),
  },
  mail_item_notice: { modes: ["off", "auto"], module: "coworking", params: mailNoticeParams, schedule: null },
};

export const AUTOMATION_KEYS = Object.keys(AUTOMATIONS) as AutomationKey[];

/** The permission a person needs to confirm a proposal of each kind; confirming runs it under their name. */
export const PROPOSAL_PERMISSION: Record<"reminders.send" | "payroll.calculate", Permission> = {
  "reminders.send": "reminders:send",
  "payroll.calculate": "payroll:calculate",
};

/**
 * Stored parameters completed with the defaults of fields added since they were saved. Parameters are validated
 * when saved; if a later version no longer accepts them, this throws and the run is recorded as failed rather than
 * silently running with other values.
 */
export function parseParams(key: AutomationKey, stored: unknown): Record<string, unknown> {
  return AUTOMATIONS[key].params.parse(stored ?? {});
}
