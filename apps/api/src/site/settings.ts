import type { Kysely, Selectable, Transaction } from "kysely";
import type { Database } from "../db/types.js";
import type { SiteSettingsTable } from "../db/types.website.js";

export type SiteSettings = Selectable<SiteSettingsTable>;

/** Minimum contrast ratio of normal text (WCAG 2 level AA), required for white text on the theme colours. */
export const MIN_CONTRAST = 4.5;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a #rrggbb colour. */
export function relativeLuminance(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio between white text and a #rrggbb background, from 1 to 21. */
export function contrastWithWhite(hex: string): number {
  return 1.05 / (relativeLuminance(hex) + 0.05);
}

/** The settings of a centre's site, created with the defaults (named after the centre) on first access. */
export async function ensureSiteSettings(db: Kysely<Database> | Transaction<Database>, centreId: string): Promise<SiteSettings> {
  const existing = await db.selectFrom("site_settings").selectAll().where("centre_id", "=", centreId).executeTakeFirst();
  if (existing) return existing;
  const centre = await db.selectFrom("centres").select("name").where("id", "=", centreId).executeTakeFirstOrThrow();
  await db
    .insertInto("site_settings")
    .values({ centre_id: centreId, site_name: centre.name })
    .onConflict((oc) => oc.column("centre_id").doNothing())
    .execute();
  return db.selectFrom("site_settings").selectAll().where("centre_id", "=", centreId).executeTakeFirstOrThrow();
}
