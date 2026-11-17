import { z } from "zod";
import { AUTOMATION_KEYS } from "../domain/automations/definitions.js";
import type { AutomationKey } from "../db/types.js";
import { settingsBody as cafeSettingsBody } from "../routes/cafe.js";
import { centreUpdate } from "../routes/centre.js";
import { settingsBody as coworkingSettingsBody } from "../routes/coworking/config.js";
import type { Permission } from "../auth/permissions.js";

/**
 * A configuration pack: the settings of a centre as values, without any operational or personal data, so that a
 * consultant can copy a validated configuration from one centre to another, keep it under version control and see
 * what applying it would change. A pack never holds code. It is read and applied through the same REST endpoints as
 * the settings screens, so every change is validated and audited the same way.
 */
export const PACK_FORMAT = "axelia.pack/1";

/** Settings that identify the centre itself: they belong to the client, never to a reusable pack. */
const CENTRE_IDENTITY = new Set(["name", "address", "taxId"]);

export interface SettingsSection {
  name: "centre" | "coworking" | "cafe";
  /** Permission needed to read and change the section; it also carries the section's module. */
  permission: Permission;
  url: string;
  method: "PATCH" | "PUT";
  keys: string[];
  /** True when the endpoint accepts only the changed fields; false when it needs the whole section. */
  partial: boolean;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    name: "centre",
    permission: "centre:manage",
    url: "/api/centre",
    method: "PATCH",
    keys: Object.keys(centreUpdate.shape).filter((k) => !CENTRE_IDENTITY.has(k)),
    partial: true,
  },
  {
    name: "coworking",
    permission: "coworking:manage",
    url: "/api/coworking/settings",
    method: "PUT",
    keys: Object.keys(coworkingSettingsBody.shape),
    partial: true,
  },
  { name: "cafe", permission: "cafe:manage", url: "/api/cafe/settings", method: "PUT", keys: Object.keys(cafeSettingsBody.shape), partial: false },
];

export const AUTOMATIONS_PERMISSION: Permission = "centre:manage";

const values = z.record(z.string(), z.unknown());

export const packSchema = z
  .object({
    format: z.literal(PACK_FORMAT),
    /** Free text kept with the pack: its name, author, the centre it was taken from. */
    label: z.string().trim().max(200).optional(),
    exportedAt: z.string().max(40).optional(),
    sections: z
      .object({
        centre: values.optional(),
        coworking: values.optional(),
        cafe: values.optional(),
        automations: z
          .array(
            z
              .object({ key: z.enum(AUTOMATION_KEYS as [AutomationKey, ...AutomationKey[]]), mode: z.enum(["off", "propose", "auto"]), params: values })
              .strict(),
          )
          .max(AUTOMATION_KEYS.length)
          .optional(),
      })
      .strict(),
  })
  .strict();

export type Pack = z.infer<typeof packSchema>;

export interface Change {
  section: string;
  field: string;
  current: unknown;
  next: unknown;
}

/** Same value for the purpose of a pack: compared as JSON, with object keys in a stable order. */
export function sameValue(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)))
      : v,
  );
}

export function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => k in source).map((k) => [k, source[k]]));
}
