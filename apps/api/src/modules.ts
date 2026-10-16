import type { Module } from "./db/types.js";

/**
 * Modules are sold separately. The core (centre settings, users, audit, payments, receipts, cash, reports)
 * is always available; each module brings its own permissions and screens.
 */
export const MODULES: readonly Module[] = ["training", "coworking", "website"];

export const MODULE_LABELS: Record<Module, string> = {
  training: "Formation et cours particuliers",
  coworking: "Coworking",
  website: "Site web",
};

export function isModule(value: string): value is Module {
  return (MODULES as readonly string[]).includes(value);
}
