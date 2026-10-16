import { parseSections, SITE_LANGUAGES, type SiteLanguage, type SiteSection } from "@gcf/shared";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/types.js";

type Db = Kysely<Database> | Transaction<Database>;

/** A page lives at most three levels deep (/parent/child/grandchild). */
export const MAX_PAGE_DEPTH = 3;

/** First path segments the public surface already uses, or that would read as a language prefix. */
export const RESERVED_ROOT_SLUGS: readonly string[] = ["api", "espace", "media", "healthz", ...SITE_LANGUAGES];

export const PAGE_COLUMNS = [
  "id",
  "kind",
  "is_home",
  "slug",
  "parent_id",
  "position",
  "show_in_menu",
  "show_in_footer",
  "article_date",
  "status",
  "published_version_id",
  "scheduled_version_id",
  "scheduled_at",
  "created_at",
  "updated_at",
] as const;

export interface PageRow {
  id: string;
  kind: "page" | "article";
  is_home: boolean;
  slug: string;
  parent_id: string | null;
  position: number;
  show_in_menu: boolean;
  show_in_footer: boolean;
  article_date: string | null;
  status: "draft" | "published" | "archived";
  published_version_id: string | null;
  scheduled_version_id: string | null;
  scheduled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** The pages of a centre that are not archived, in menu order. */
export async function loadLivePages(db: Db, centreId: string): Promise<PageRow[]> {
  return db
    .selectFrom("site_pages")
    .select(PAGE_COLUMNS)
    .where("centre_id", "=", centreId)
    .where("status", "<>", "archived")
    .orderBy("position")
    .orderBy("created_at")
    .execute();
}

/** Slugs from the top of the tree down to the page; the home page has none because it lives at the root. */
export function slugChain(byId: ReadonlyMap<string, PageRow>, page: PageRow): string[] {
  if (page.is_home) return [];
  const slugs: string[] = [];
  let current: PageRow | undefined = page;
  while (current) {
    slugs.unshift(current.slug);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return slugs;
}

/** Public path of a page in a language: the default language at the root, the other one under its prefix. */
export function publicPath(slugs: readonly string[], language: SiteLanguage, defaultLanguage: SiteLanguage): string {
  const segments = language === defaultLanguage ? slugs : [language, ...slugs];
  return `/${segments.join("/")}`;
}

/** What a published version holds for one language. */
export interface LanguageContent {
  title: string;
  menuLabel: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  ogMediaId: string | null;
  sections: SiteSection[];
}

export type VersionContent = Partial<Record<SiteLanguage, LanguageContent>>;

const nullableString = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** Reads the JSON of site_page_versions.content ({ languages: { fr: {...}, en: {...} } }). */
export function readVersionContent(value: unknown): VersionContent {
  const languages = (value as { languages?: Record<string, Record<string, unknown>> } | null)?.languages;
  const content: VersionContent = {};
  if (!languages || typeof languages !== "object") return content;
  for (const language of SITE_LANGUAGES) {
    const entry = languages[language];
    if (!entry || typeof entry.title !== "string") continue;
    content[language] = {
      title: entry.title,
      menuLabel: nullableString(entry.menuLabel),
      seoTitle: nullableString(entry.seoTitle),
      seoDescription: nullableString(entry.seoDescription),
      ogMediaId: nullableString(entry.ogMediaId),
      sections: parseSections(entry.sections),
    };
  }
  return content;
}

/** The published content of the given versions, by version id. */
export async function loadVersionContents(db: Db, versionIds: readonly string[]): Promise<Map<string, VersionContent>> {
  if (versionIds.length === 0) return new Map();
  const rows = await db
    .selectFrom("site_page_versions")
    .select(["id", "content"])
    .where("id", "in", [...new Set(versionIds)])
    .execute();
  return new Map(rows.map((r) => [r.id, readVersionContent(r.content)]));
}
