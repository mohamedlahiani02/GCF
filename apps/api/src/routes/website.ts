import { isHttpsUrl, sectionMediaIds, sectionPageIds, SITE_LANGUAGES, siteSectionsSchema, type SiteLanguage } from "@gcf/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { can } from "../auth/permissions.js";
import type { Database } from "../db/types.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { loadLivePages, MAX_PAGE_DEPTH, PAGE_COLUMNS, publicPath, readVersionContent, RESERVED_ROOT_SLUGS, slugChain, type PageRow } from "../site/pages.js";
import { contentSecurityPolicy } from "../site/render.js";
import { contrastWithWhite, ensureSiteSettings, MIN_CONTRAST, type SiteSettings } from "../site/settings.js";
import { loadSiteState, renderSitePage } from "../site/view.js";
import { idParam, isoDate, optionalEmail, optionalText, uuid } from "../validation.js";

type Trx = Transaction<Database>;

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "expected #rrggbb")
  .transform((v) => v.toLowerCase());
const optionalHttpsUrl = z
  .union([z.literal(""), z.string().trim().max(500).refine(isHttpsUrl, "expected an https:// address")])
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional();
const language = z.enum(SITE_LANGUAGES);

const settingsBody = z
  .object({
    online: z.boolean(),
    theme: z.enum(["corporate", "creative", "minimal"]),
    primaryColor: hexColor,
    secondaryColor: hexColor,
    font: z.enum(["system", "serif", "plex", "inter", "poppins"]),
    radius: z.enum(["none", "small", "large"]),
    colorScheme: z.enum(["light", "dark"]),
    logoMediaId: uuid.nullable(),
    faviconMediaId: uuid.nullable(),
    languages: z
      .array(language)
      .min(1)
      .max(SITE_LANGUAGES.length)
      .refine((l) => new Set(l).size === l.length, "each language appears once"),
    defaultLanguage: language,
    siteName: optionalText(120),
    tagline: optionalText(200),
    contactEmail: optionalEmail,
    contactPhone: optionalText(40),
    address: optionalText(300),
    mapUrl: optionalHttpsUrl,
    facebookUrl: optionalHttpsUrl,
    instagramUrl: optionalHttpsUrl,
    linkedinUrl: optionalHttpsUrl,
    seoDescription: optionalText(300),
    footerText: optionalText(1000),
  })
  .partial()
  .strict();

const slug = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lowercase letters, digits and hyphens")
  .max(80);
const pageCreate = z
  .object({
    kind: z.enum(["page", "article"]).default("page"),
    title: z.string().trim().min(1).max(200),
    slug,
    parentId: uuid.nullable().optional(),
    showInMenu: z.boolean().optional(),
    showInFooter: z.boolean().optional(),
    articleDate: isoDate.optional(),
  })
  .strict();
const pageUpdate = z.object({ slug, parentId: uuid.nullable(), showInMenu: z.boolean(), showInFooter: z.boolean(), articleDate: isoDate }).partial().strict();
const reorderBody = z
  .object({ parentId: uuid.nullable(), pageIds: z.array(uuid).min(1).max(500) })
  .strict()
  .refine((b) => new Set(b.pageIds).size === b.pageIds.length, "each page appears once");
const draftParams = z.object({ id: uuid, language });
const draftBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    menuLabel: optionalText(60),
    seoTitle: optionalText(70),
    seoDescription: optionalText(300),
    ogMediaId: uuid.nullable().optional(),
    sections: siteSectionsSchema,
  })
  .strict();
const publishBody = z.object({ at: z.iso.datetime({ offset: true }).optional() }).strict();
const versionParams = z.object({ id: uuid, versionId: uuid });
const previewQuery = z.object({ language: language.optional() });
const sitePath = z
  .string()
  .trim()
  .max(300)
  .regex(/^\/[^?#\s]*$/, "expected a path starting with /")
  .transform((p) => (p.length > 1 ? p.replace(/\/+$/, "") || "/" : p));
const redirectBody = z
  .object({ fromPath: sitePath, toPath: sitePath })
  .strict()
  .refine((r) => r.fromPath !== r.toPath, "the redirect must lead elsewhere");
const leadsQuery = z.object({
  status: z.enum(["new", "handled", "spam"]).optional(),
  kind: z.enum(["contact", "visit", "quote"]).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const leadUpdate = z.object({ status: z.enum(["new", "handled", "spam"]) }).strict();

const presentSettings = (s: SiteSettings) => ({
  online: s.online,
  theme: s.theme,
  primaryColor: s.primary_color,
  secondaryColor: s.secondary_color,
  font: s.font,
  radius: s.radius,
  colorScheme: s.color_scheme,
  logoMediaId: s.logo_media_id,
  faviconMediaId: s.favicon_media_id,
  languages: s.languages,
  defaultLanguage: s.default_language,
  siteName: s.site_name,
  tagline: s.tagline,
  contactEmail: s.contact_email,
  contactPhone: s.contact_phone,
  address: s.address,
  mapUrl: s.map_url,
  facebookUrl: s.facebook_url,
  instagramUrl: s.instagram_url,
  linkedinUrl: s.linkedin_url,
  seoDescription: s.seo_description,
  footerText: s.footer_text,
  updatedAt: s.updated_at,
});

const presentPage = (p: PageRow) => ({
  id: p.id,
  kind: p.kind,
  slug: p.slug,
  parentId: p.parent_id,
  position: p.position,
  isHome: p.is_home,
  showInMenu: p.show_in_menu,
  showInFooter: p.show_in_footer,
  articleDate: p.article_date,
  status: p.status,
  scheduledAt: p.scheduled_at,
  updatedAt: p.updated_at,
});

/** Media files the site may newly reference must be active files of the centre. */
async function assertActiveMedia(trx: Trx, centreId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const found = await trx
    .selectFrom("media_files")
    .select("id")
    .where("centre_id", "=", centreId)
    .where("status", "=", "active")
    .where("id", "in", ids)
    .execute();
  const missing = ids.filter((id) => !found.some((f) => f.id === id));
  if (missing.length) throw unprocessable("unknown_media", "an image does not exist or is archived", { ids: missing });
}

async function assertLivePages(trx: Trx, centreId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const found = await trx
    .selectFrom("site_pages")
    .select("id")
    .where("centre_id", "=", centreId)
    .where("status", "<>", "archived")
    .where("id", "in", ids)
    .execute();
  const missing = ids.filter((id) => !found.some((f) => f.id === id));
  if (missing.length) throw unprocessable("unknown_page", "a linked page does not exist or is archived", { ids: missing });
}

async function lockPage(trx: Trx, centreId: string, id: string): Promise<PageRow> {
  const page = await trx.selectFrom("site_pages").select(PAGE_COLUMNS).where("id", "=", id).where("centre_id", "=", centreId).forUpdate().executeTakeFirst();
  if (!page) throw notFound("page");
  return page;
}

function descendantsOf(pages: readonly PageRow[], id: string): PageRow[] {
  const children = pages.filter((p) => p.parent_id === id);
  return children.flatMap((c) => [c, ...descendantsOf(pages, c.id)]);
}

function depthOf(byId: ReadonlyMap<string, PageRow>, id: string | null): number {
  let depth = 0;
  for (let current = id ? byId.get(id) : undefined; current; current = current.parent_id ? byId.get(current.parent_id) : undefined) depth += 1;
  return depth;
}

/** Checks the place of a page in the tree: an existing content page as parent, no cycle, no reserved or taken path. */
function checkPlacement(pages: readonly PageRow[], page: { id: string | null; slug: string; parent_id: string | null; is_home: boolean }): void {
  const byId = new Map(pages.map((p) => [p.id, p]));
  if (page.parent_id) {
    const parent = byId.get(page.parent_id);
    if (!parent || parent.kind !== "page" || parent.is_home || page.is_home)
      throw unprocessable("invalid_parent", "the parent must be a content page other than the home page");
    if (page.id && (parent.id === page.id || descendantsOf(pages, page.id).some((d) => d.id === parent.id)))
      throw unprocessable("invalid_parent", "a page cannot be placed under itself");
    const height = page.id ? Math.max(0, ...descendantsOf(pages, page.id).map((d) => depthOf(byId, d.id) - depthOf(byId, page.id))) : 0;
    if (depthOf(byId, parent.id) + 1 + height > MAX_PAGE_DEPTH) throw unprocessable("too_deep", `pages are nested at most ${MAX_PAGE_DEPTH} levels deep`);
  } else if (RESERVED_ROOT_SLUGS.includes(page.slug)) {
    throw unprocessable("reserved_slug", "this address is reserved", { slug: page.slug });
  }
  if (pages.some((p) => p.id !== page.id && p.parent_id === page.parent_id && p.slug === page.slug))
    throw conflict("slug_taken", "another page already uses this address");
}

/**
 * Keeps old addresses of moved published pages working: each old public path redirects to the new one, older
 * redirects to the old path are pointed straight at the new one (never a chain), and redirects from the new
 * path are dropped since a page lives there now.
 */
async function redirectMovedPaths(trx: Trx, centreId: string, userId: string, moves: { from: string; to: string }[]): Promise<void> {
  for (const move of moves) {
    if (move.from === move.to) continue;
    await trx.deleteFrom("site_redirects").where("centre_id", "=", centreId).where("from_path", "=", move.to).execute();
    await trx.updateTable("site_redirects").set({ to_path: move.to }).where("centre_id", "=", centreId).where("to_path", "=", move.from).execute();
    await trx
      .insertInto("site_redirects")
      .values({ centre_id: centreId, from_path: move.from, to_path: move.to, automatic: true, created_by: userId })
      .onConflict((oc) => oc.columns(["centre_id", "from_path"]).doUpdateSet({ to_path: move.to, automatic: true }))
      .execute();
  }
}

/** Public paths of a published page and its published descendants, in every enabled language. */
function publishedPaths(pages: readonly PageRow[], root: PageRow, settings: SiteSettings): Map<string, string> {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const paths = new Map<string, string>();
  for (const p of [root, ...descendantsOf(pages, root.id)]) {
    if (p.status !== "published") continue;
    for (const l of settings.languages) paths.set(`${p.id}:${l}`, publicPath(slugChain(byId, p), l, settings.default_language));
  }
  return paths;
}

/** Website management: settings, pages, drafts, versions, redirects and leads (staff). */
export const websiteRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const edit = app.requirePermission("website:edit");
  const publish = app.requirePermission("website:publish");
  const leads = app.requirePermission("website:leads");

  /* Settings */

  app.get("/settings", { preHandler: edit }, async (request) => presentSettings(await ensureSiteSettings(db, request.user!.centreId)));

  app.put("/settings", { preHandler: edit }, async (request) => {
    const actor = request.user!;
    const body = settingsBody.parse(request.body);
    // Taking the site online or offline changes what the public sees, like publishing a page.
    if (body.online !== undefined && !can(actor, "website:publish")) throw forbidden();
    for (const [field, color] of [
      ["primaryColor", body.primaryColor],
      ["secondaryColor", body.secondaryColor],
    ] as const) {
      if (color === undefined) continue;
      const ratio = contrastWithWhite(color);
      if (ratio < MIN_CONTRAST)
        throw unprocessable("low_contrast", "white text on this colour is not readable enough", {
          field,
          ratio: Math.round(ratio * 100) / 100,
          minimum: MIN_CONTRAST,
        });
    }
    return db.transaction().execute(async (trx) => {
      await ensureSiteSettings(trx, actor.centreId);
      const before = await trx.selectFrom("site_settings").selectAll().where("centre_id", "=", actor.centreId).forUpdate().executeTakeFirstOrThrow();
      const languages = body.languages ?? before.languages;
      const defaultLanguage =
        body.defaultLanguage ?? (body.languages && !body.languages.includes(before.default_language) ? body.languages[0]! : before.default_language);
      if (!languages.includes(defaultLanguage)) throw unprocessable("invalid_default_language", "the default language must be one of the site languages");
      await assertActiveMedia(
        trx,
        actor.centreId,
        [body.logoMediaId, body.faviconMediaId].filter((id): id is string => !!id),
      );
      const after = await trx
        .updateTable("site_settings")
        .set({
          ...(body.online === undefined ? {} : { online: body.online }),
          ...(body.theme === undefined ? {} : { theme: body.theme }),
          ...(body.primaryColor === undefined ? {} : { primary_color: body.primaryColor }),
          ...(body.secondaryColor === undefined ? {} : { secondary_color: body.secondaryColor }),
          ...(body.font === undefined ? {} : { font: body.font }),
          ...(body.radius === undefined ? {} : { radius: body.radius }),
          ...(body.colorScheme === undefined ? {} : { color_scheme: body.colorScheme }),
          ...(body.logoMediaId === undefined ? {} : { logo_media_id: body.logoMediaId }),
          ...(body.faviconMediaId === undefined ? {} : { favicon_media_id: body.faviconMediaId }),
          languages,
          default_language: defaultLanguage,
          ...(body.siteName === undefined ? {} : { site_name: body.siteName }),
          ...(body.tagline === undefined ? {} : { tagline: body.tagline }),
          ...(body.contactEmail === undefined ? {} : { contact_email: body.contactEmail }),
          ...(body.contactPhone === undefined ? {} : { contact_phone: body.contactPhone }),
          ...(body.address === undefined ? {} : { address: body.address }),
          ...(body.mapUrl === undefined ? {} : { map_url: body.mapUrl }),
          ...(body.facebookUrl === undefined ? {} : { facebook_url: body.facebookUrl }),
          ...(body.instagramUrl === undefined ? {} : { instagram_url: body.instagramUrl }),
          ...(body.linkedinUrl === undefined ? {} : { linkedin_url: body.linkedinUrl }),
          ...(body.seoDescription === undefined ? {} : { seo_description: body.seoDescription }),
          ...(body.footerText === undefined ? {} : { footer_text: body.footerText }),
          updated_at: new Date(),
          updated_by: actor.userId,
        })
        .where("centre_id", "=", actor.centreId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "site_settings.updated",
        objectType: "site_settings",
        objectId: actor.centreId,
        before: presentSettings(before),
        after: presentSettings(after),
      });
      return presentSettings(after);
    });
  });

  /* Pages */

  app.get("/pages", { preHandler: edit }, async (request) => {
    const centreId = request.user!.centreId;
    const pages = await loadLivePages(db, centreId);
    const settings = await ensureSiteSettings(db, centreId);
    const ids = pages.map((p) => p.id);
    const drafts = ids.length ? await db.selectFrom("site_page_drafts").select(["page_id", "language", "title"]).where("page_id", "in", ids).execute() : [];
    const versionIds = pages.flatMap((p) => [p.published_version_id, p.scheduled_version_id]).filter((v): v is string => !!v);
    const numbers = new Map(
      (versionIds.length ? await db.selectFrom("site_page_versions").select(["id", "number"]).where("id", "in", versionIds).execute() : []).map((v) => [
        v.id,
        v.number,
      ]),
    );
    const byId = new Map(pages.map((p) => [p.id, p]));
    type Node = ReturnType<typeof presentPage> & {
      path: string;
      titles: Partial<Record<SiteLanguage, string>>;
      publishedVersion: number | null;
      scheduledVersion: number | null;
      children: Node[];
    };
    const node = (p: PageRow): Node => ({
      ...presentPage(p),
      path: publicPath(slugChain(byId, p), settings.default_language, settings.default_language),
      titles: Object.fromEntries(drafts.filter((d) => d.page_id === p.id).map((d) => [d.language, d.title])),
      publishedVersion: p.status === "published" && p.published_version_id ? (numbers.get(p.published_version_id) ?? null) : null,
      scheduledVersion: p.scheduled_version_id ? (numbers.get(p.scheduled_version_id) ?? null) : null,
      children: pages.filter((c) => c.parent_id === p.id).map(node),
    });
    return pages.filter((p) => p.parent_id === null).map(node);
  });

  app.post("/pages", { preHandler: edit }, async (request, reply) => {
    const actor = request.user!;
    const body = pageCreate.parse(request.body);
    if ((body.kind === "article") !== (body.articleDate !== undefined))
      throw unprocessable("article_date_required", "an article has a date and a page has none");
    const created = await db.transaction().execute(async (trx) => {
      const settings = await ensureSiteSettings(trx, actor.centreId);
      // Serialises page creation per centre so two pages cannot take the same path or position.
      await trx.selectFrom("site_settings").select("centre_id").where("centre_id", "=", actor.centreId).forUpdate().execute();
      const pages = await loadLivePages(trx, actor.centreId);
      const parentId = body.parentId ?? null;
      checkPlacement(pages, { id: null, slug: body.slug, parent_id: parentId, is_home: false });
      const position = Math.max(-1, ...pages.filter((p) => p.parent_id === parentId).map((p) => p.position)) + 1;
      const page = await trx
        .insertInto("site_pages")
        .values({
          centre_id: actor.centreId,
          kind: body.kind,
          slug: body.slug,
          parent_id: parentId,
          position,
          show_in_menu: body.showInMenu ?? false,
          show_in_footer: body.showInFooter ?? false,
          article_date: body.articleDate ?? null,
          created_by: actor.userId,
        })
        .returning(PAGE_COLUMNS)
        .executeTakeFirstOrThrow();
      await trx
        .insertInto("site_page_drafts")
        .values(settings.languages.map((l) => ({ page_id: page.id, language: l, title: body.title, sections: "[]", updated_by: actor.userId })))
        .execute();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "site_page.created",
        objectType: "site_page",
        objectId: page.id,
        after: { ...presentPage(page), title: body.title },
      });
      return page;
    });
    return reply.status(201).send(presentPage(created));
  });

  app.patch("/pages/:id", { preHandler: edit }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = pageUpdate.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const settings = await ensureSiteSettings(trx, actor.centreId);
      await trx.selectFrom("site_settings").select("centre_id").where("centre_id", "=", actor.centreId).forUpdate().execute();
      const before = await lockPage(trx, actor.centreId, id);
      if (before.status === "archived") throw conflict("page_archived", "the page is archived");
      if (body.articleDate !== undefined && before.kind !== "article") throw unprocessable("article_date_required", "only an article has a date");
      const pages = await loadLivePages(trx, actor.centreId);
      const moved = (body.slug !== undefined && body.slug !== before.slug) || (body.parentId !== undefined && body.parentId !== before.parent_id);
      const target = { ...before, slug: body.slug ?? before.slug, parent_id: body.parentId === undefined ? before.parent_id : body.parentId };
      if (moved) checkPlacement(pages, target);
      const oldPaths = publishedPaths(pages, before, settings);
      const position =
        body.parentId !== undefined && body.parentId !== before.parent_id
          ? Math.max(-1, ...pages.filter((p) => p.parent_id === body.parentId && p.id !== id).map((p) => p.position)) + 1
          : before.position;
      const after = await trx
        .updateTable("site_pages")
        .set({
          slug: target.slug,
          parent_id: target.parent_id,
          position,
          ...(body.showInMenu === undefined ? {} : { show_in_menu: body.showInMenu }),
          ...(body.showInFooter === undefined ? {} : { show_in_footer: body.showInFooter }),
          ...(body.articleDate === undefined ? {} : { article_date: body.articleDate }),
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .returning(PAGE_COLUMNS)
        .executeTakeFirstOrThrow();
      if (moved) {
        const updated = pages.map((p) => (p.id === id ? after : p));
        const newPaths = publishedPaths(updated, after, settings);
        await redirectMovedPaths(
          trx,
          actor.centreId,
          actor.userId,
          [...oldPaths].map(([key, from]) => ({ from, to: newPaths.get(key)! })),
        );
      }
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "site_page.updated",
        objectType: "site_page",
        objectId: id,
        before: presentPage(before),
        after: presentPage(after),
      });
      return presentPage(after);
    });
  });

  app.post("/pages/reorder", { preHandler: edit }, async (request) => {
    const actor = request.user!;
    const body = reorderBody.parse(request.body);
    return db.transaction().execute(async (trx) => {
      await ensureSiteSettings(trx, actor.centreId);
      await trx.selectFrom("site_settings").select("centre_id").where("centre_id", "=", actor.centreId).forUpdate().execute();
      const siblings = (await loadLivePages(trx, actor.centreId)).filter((p) => p.parent_id === body.parentId);
      if (siblings.length !== body.pageIds.length || siblings.some((s) => !body.pageIds.includes(s.id)))
        throw unprocessable("invalid_order", "give every page of that level exactly once");
      for (const [position, pageId] of body.pageIds.entries()) {
        await trx.updateTable("site_pages").set({ position }).where("id", "=", pageId).execute();
      }
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "site_page.reordered",
        objectType: "site_page",
        objectId: body.parentId ?? actor.centreId,
        after: { parentId: body.parentId, pageIds: body.pageIds },
      });
      return { parentId: body.parentId, pageIds: body.pageIds };
    });
  });

  // Archiving a published page takes it off the site without a redirect: its address simply stops existing.
  app.post("/pages/:id/archive", { preHandler: edit }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    return db.transaction().execute(async (trx) => {
      const before = await lockPage(trx, actor.centreId, id);
      if (before.status === "archived") return presentPage(before);
      if (before.status === "published" && !can(actor, "website:publish")) throw forbidden();
      if (before.is_home) throw conflict("home_page", "the home page cannot be archived; choose another home page first");
      const child = await trx.selectFrom("site_pages").select("id").where("parent_id", "=", id).where("status", "<>", "archived").executeTakeFirst();
      if (child) throw conflict("page_has_children", "move or archive the pages under this one first");
      const after = await trx
        .updateTable("site_pages")
        .set({ status: "archived", scheduled_version_id: null, scheduled_at: null, show_in_menu: false, show_in_footer: false, updated_at: new Date() })
        .where("id", "=", id)
        .returning(PAGE_COLUMNS)
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "site_page.archived",
        objectType: "site_page",
        objectId: id,
        before: presentPage(before),
        after: presentPage(after),
      });
      return presentPage(after);
    });
  });

  app.post("/pages/:id/home", { preHandler: publish }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    return db.transaction().execute(async (trx) => {
      await ensureSiteSettings(trx, actor.centreId);
      await trx.selectFrom("site_settings").select("centre_id").where("centre_id", "=", actor.centreId).forUpdate().execute();
      const page = await lockPage(trx, actor.centreId, id);
      if (page.status === "archived") throw conflict("page_archived", "the page is archived");
      if (page.kind !== "page" || page.parent_id !== null) throw unprocessable("invalid_home", "the home page is a top-level content page");
      if (page.is_home) return presentPage(page);
      const child = await trx.selectFrom("site_pages").select("id").where("parent_id", "=", id).where("status", "<>", "archived").executeTakeFirst();
      if (child) throw conflict("page_has_children", "the home page cannot have pages under it");
      const previous = await trx
        .updateTable("site_pages")
        .set({ is_home: false, updated_at: new Date() })
        .where("centre_id", "=", actor.centreId)
        .where("is_home", "=", true)
        .returning("id")
        .executeTakeFirst();
      const after = await trx
        .updateTable("site_pages")
        .set({ is_home: true, updated_at: new Date() })
        .where("id", "=", id)
        .returning(PAGE_COLUMNS)
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "site_page.set_home",
        objectType: "site_page",
        objectId: id,
        before: { homePageId: previous?.id ?? null },
        after: { homePageId: id },
      });
      return presentPage(after);
    });
  });

  /* Drafts */

  app.get("/pages/:id/drafts/:language", { preHandler: edit }, async (request) => {
    const centreId = request.user!.centreId;
    const params = draftParams.parse(request.params);
    const settings = await ensureSiteSettings(db, centreId);
    if (!settings.languages.includes(params.language)) throw unprocessable("language_not_enabled", "this language is not enabled on the site");
    const page = await db.selectFrom("site_pages").select("id").where("id", "=", params.id).where("centre_id", "=", centreId).executeTakeFirst();
    if (!page) throw notFound("page");
    const draft = await db
      .selectFrom("site_page_drafts")
      .selectAll()
      .where("page_id", "=", params.id)
      .where("language", "=", params.language)
      .executeTakeFirst();
    if (!draft)
      return { language: params.language, title: "", menuLabel: null, seoTitle: null, seoDescription: null, ogMediaId: null, sections: [], updatedAt: null };
    return {
      language: draft.language,
      title: draft.title,
      menuLabel: draft.menu_label,
      seoTitle: draft.seo_title,
      seoDescription: draft.seo_description,
      ogMediaId: draft.og_media_id,
      sections: draft.sections,
      updatedAt: draft.updated_at,
    };
  });

  app.put("/pages/:id/drafts/:language", { preHandler: edit, bodyLimit: 1024 * 1024 }, async (request) => {
    const actor = request.user!;
    const params = draftParams.parse(request.params);
    const body = draftBody.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const settings = await ensureSiteSettings(trx, actor.centreId);
      if (!settings.languages.includes(params.language)) throw unprocessable("language_not_enabled", "this language is not enabled on the site");
      const page = await lockPage(trx, actor.centreId, params.id);
      if (page.status === "archived") throw conflict("page_archived", "the page is archived");
      await assertActiveMedia(trx, actor.centreId, [...sectionMediaIds(body.sections), ...(body.ogMediaId ? [body.ogMediaId] : [])]);
      await assertLivePages(trx, actor.centreId, sectionPageIds(body.sections));
      const values = {
        title: body.title,
        menu_label: body.menuLabel ?? null,
        seo_title: body.seoTitle ?? null,
        seo_description: body.seoDescription ?? null,
        og_media_id: body.ogMediaId ?? null,
        sections: JSON.stringify(body.sections),
        updated_at: new Date(),
        updated_by: actor.userId,
      };
      const draft = await trx
        .insertInto("site_page_drafts")
        .values({ page_id: params.id, language: params.language, ...values })
        .onConflict((oc) => oc.columns(["page_id", "language"]).doUpdateSet(values))
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx.updateTable("site_pages").set({ updated_at: new Date() }).where("id", "=", params.id).execute();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "site_page.draft_saved",
        objectType: "site_page",
        objectId: params.id,
        after: { language: params.language, title: body.title, sections: body.sections.length },
      });
      return {
        language: draft.language,
        title: draft.title,
        menuLabel: draft.menu_label,
        seoTitle: draft.seo_title,
        seoDescription: draft.seo_description,
        ogMediaId: draft.og_media_id,
        sections: draft.sections,
        updatedAt: draft.updated_at,
      };
    });
  });

  app.get("/pages/:id/preview", { preHandler: edit }, async (request, reply) => {
    const centreId = request.user!.centreId;
    const { id } = idParam.parse(request.params);
    const query = previewQuery.parse(request.query);
    const settings = await ensureSiteSettings(db, centreId);
    const lang = query.language ?? settings.default_language;
    const state = await loadSiteState(db, centreId);
    const page = state?.byId.get(id);
    if (!state || !page) throw notFound("page");
    const draft = await db.selectFrom("site_page_drafts").selectAll().where("page_id", "=", id).where("language", "=", lang).executeTakeFirst();
    if (!draft) throw notFound("draft");
    const content = readVersionContent({
      languages: {
        [lang]: {
          title: draft.title,
          menuLabel: draft.menu_label,
          seoTitle: draft.seo_title,
          seoDescription: draft.seo_description,
          ogMediaId: draft.og_media_id,
          sections: draft.sections,
        },
      },
    })[lang]!;
    const rendered = await renderSitePage(db, state, {
      page,
      language: lang,
      content,
      preview: true,
      formStatus: null,
      origin: app.config.publicOrigin ?? app.config.webOrigin,
      now: new Date(),
    });
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .header("x-robots-tag", "noindex")
      .header("content-security-policy", contentSecurityPolicy(rendered.usesGoogleFonts))
      .send(rendered.html);
  });

  /* Publication and versions */

  app.post("/pages/:id/publish", { preHandler: publish }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = publishBody.parse(request.body ?? {});
    const at = body.at ? new Date(body.at) : null;
    if (at && at.getTime() <= Date.now()) throw unprocessable("schedule_in_past", "the publication time must be in the future");
    return db.transaction().execute(async (trx) => {
      const settings = await ensureSiteSettings(trx, actor.centreId);
      const before = await lockPage(trx, actor.centreId, id);
      if (before.status === "archived") throw conflict("page_archived", "the page is archived");
      const drafts = await trx.selectFrom("site_page_drafts").selectAll().where("page_id", "=", id).execute();
      const missing = settings.languages.filter((l) => !drafts.some((d) => d.language === l && d.title.trim() !== ""));
      if (missing.length) throw unprocessable("missing_translation", "every site language needs a title before publication", { languages: missing });
      const content = {
        languages: Object.fromEntries(
          drafts.map((d) => [
            d.language,
            {
              title: d.title,
              menuLabel: d.menu_label,
              seoTitle: d.seo_title,
              seoDescription: d.seo_description,
              ogMediaId: d.og_media_id,
              sections: d.sections,
            },
          ]),
        ),
      };
      const last = await trx
        .selectFrom("site_page_versions")
        .select(sql<number>`coalesce(max(number), 0)`.as("n"))
        .where("page_id", "=", id)
        .executeTakeFirstOrThrow();
      const version = await trx
        .insertInto("site_page_versions")
        .values({ page_id: id, number: Number(last.n) + 1, content: JSON.stringify(content), created_by: actor.userId })
        .returning(["id", "number", "created_at"])
        .executeTakeFirstOrThrow();
      const after = await trx
        .updateTable("site_pages")
        .set(
          at
            ? { scheduled_version_id: version.id, scheduled_at: at, updated_at: new Date() }
            : { published_version_id: version.id, status: "published", scheduled_version_id: null, scheduled_at: null, updated_at: new Date() },
        )
        .where("id", "=", id)
        .returning(PAGE_COLUMNS)
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: at ? "site_page.scheduled" : "site_page.published",
        objectType: "site_page",
        objectId: id,
        after: { versionId: version.id, number: version.number, scheduledAt: at },
      });
      return { ...presentPage(after), version: { id: version.id, number: version.number, createdAt: version.created_at } };
    });
  });

  app.delete("/pages/:id/schedule", { preHandler: publish }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    return db.transaction().execute(async (trx) => {
      const before = await lockPage(trx, actor.centreId, id);
      if (!before.scheduled_version_id) return presentPage(before);
      const after = await trx
        .updateTable("site_pages")
        .set({ scheduled_version_id: null, scheduled_at: null, updated_at: new Date() })
        .where("id", "=", id)
        .returning(PAGE_COLUMNS)
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "site_page.schedule_cancelled",
        objectType: "site_page",
        objectId: id,
        before: { versionId: before.scheduled_version_id, scheduledAt: before.scheduled_at },
      });
      return presentPage(after);
    });
  });

  app.post("/pages/:id/unpublish", { preHandler: publish }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    return db.transaction().execute(async (trx) => {
      const before = await lockPage(trx, actor.centreId, id);
      if (before.status !== "published") throw conflict("not_published", "the page is not published");
      const after = await trx
        .updateTable("site_pages")
        .set({ status: "draft", published_version_id: null, updated_at: new Date() })
        .where("id", "=", id)
        .returning(PAGE_COLUMNS)
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "site_page.unpublished",
        objectType: "site_page",
        objectId: id,
        before: { versionId: before.published_version_id },
      });
      return presentPage(after);
    });
  });

  app.get("/pages/:id/versions", { preHandler: edit }, async (request) => {
    const centreId = request.user!.centreId;
    const { id } = idParam.parse(request.params);
    const page = await db
      .selectFrom("site_pages")
      .select(["id", "published_version_id", "scheduled_version_id"])
      .where("id", "=", id)
      .where("centre_id", "=", centreId)
      .executeTakeFirst();
    if (!page) throw notFound("page");
    const rows = await db
      .selectFrom("site_page_versions")
      .leftJoin("users", "users.id", "site_page_versions.created_by")
      .select([
        "site_page_versions.id",
        "site_page_versions.number",
        "site_page_versions.content",
        "site_page_versions.created_at as createdAt",
        "users.full_name as createdBy",
      ])
      .where("site_page_versions.page_id", "=", id)
      .orderBy("site_page_versions.number", "desc")
      .execute();
    return rows.map((v) => {
      const content = readVersionContent(v.content);
      return {
        id: v.id,
        number: v.number,
        createdAt: v.createdAt,
        createdBy: v.createdBy,
        published: v.id === page.published_version_id,
        scheduled: v.id === page.scheduled_version_id,
        titles: Object.fromEntries(Object.entries(content).map(([l, c]) => [l, c.title])),
      };
    });
  });

  app.post("/pages/:id/versions/:versionId/restore", { preHandler: edit }, async (request) => {
    const actor = request.user!;
    const params = versionParams.parse(request.params);
    return db.transaction().execute(async (trx) => {
      const page = await lockPage(trx, actor.centreId, params.id);
      if (page.status === "archived") throw conflict("page_archived", "the page is archived");
      const version = await trx
        .selectFrom("site_page_versions")
        .select(["id", "number", "content"])
        .where("id", "=", params.versionId)
        .where("page_id", "=", params.id)
        .executeTakeFirst();
      if (!version) throw notFound("version");
      const content = readVersionContent(version.content);
      const restored: SiteLanguage[] = [];
      for (const [lang, c] of Object.entries(content) as [SiteLanguage, NonNullable<(typeof content)[SiteLanguage]>][]) {
        const values = {
          title: c.title,
          menu_label: c.menuLabel,
          seo_title: c.seoTitle,
          seo_description: c.seoDescription,
          og_media_id: c.ogMediaId,
          sections: JSON.stringify(c.sections),
          updated_at: new Date(),
          updated_by: actor.userId,
        };
        await trx
          .insertInto("site_page_drafts")
          .values({ page_id: params.id, language: lang, ...values })
          .onConflict((oc) => oc.columns(["page_id", "language"]).doUpdateSet(values))
          .execute();
        restored.push(lang);
      }
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "site_page.version_restored",
        objectType: "site_page",
        objectId: params.id,
        after: { versionId: version.id, number: version.number, languages: restored },
      });
      return { versionId: version.id, number: version.number, languages: restored };
    });
  });

  /* Redirects */

  app.get("/redirects", { preHandler: edit }, async (request) =>
    db
      .selectFrom("site_redirects")
      .select(["id", "from_path as fromPath", "to_path as toPath", "automatic", "created_at as createdAt"])
      .where("centre_id", "=", request.user!.centreId)
      .orderBy("from_path")
      .execute(),
  );

  app.post("/redirects", { preHandler: edit }, async (request, reply) => {
    const actor = request.user!;
    const body = redirectBody.parse(request.body);
    const created = await db.transaction().execute(async (trx) => {
      // A redirect to a path that itself redirects is pointed at the final target, so visitors never follow a chain.
      const next = await trx
        .selectFrom("site_redirects")
        .select("to_path")
        .where("centre_id", "=", actor.centreId)
        .where("from_path", "=", body.toPath)
        .executeTakeFirst();
      const toPath = next?.to_path ?? body.toPath;
      if (toPath === body.fromPath) throw unprocessable("redirect_loop", "this redirect would lead back to itself");
      const row = await trx
        .insertInto("site_redirects")
        .values({ centre_id: actor.centreId, from_path: body.fromPath, to_path: toPath, automatic: false, created_by: actor.userId })
        .returning(["id", "from_path as fromPath", "to_path as toPath", "automatic", "created_at as createdAt"])
        .executeTakeFirstOrThrow();
      await trx.updateTable("site_redirects").set({ to_path: toPath }).where("centre_id", "=", actor.centreId).where("to_path", "=", body.fromPath).execute();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "site_redirect.created",
        objectType: "site_redirect",
        objectId: row.id,
        after: row,
      });
      return row;
    });
    return reply.status(201).send(created);
  });

  app.delete("/redirects/:id", { preHandler: edit }, async (request, reply) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    await db.transaction().execute(async (trx) => {
      const row = await trx
        .deleteFrom("site_redirects")
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .returning(["id", "from_path as fromPath", "to_path as toPath", "automatic"])
        .executeTakeFirst();
      if (!row) throw notFound("redirect");
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "site_redirect.deleted",
        objectType: "site_redirect",
        objectId: id,
        before: row,
      });
    });
    return reply.status(204).send();
  });

  /* Leads */

  app.get("/leads", { preHandler: leads }, async (request) => {
    const query = leadsQuery.parse(request.query);
    let base = db.selectFrom("site_leads").leftJoin("users", "users.id", "site_leads.handled_by").where("site_leads.centre_id", "=", request.user!.centreId);
    if (query.status) base = base.where("site_leads.status", "=", query.status);
    if (query.kind) base = base.where("site_leads.kind", "=", query.kind);
    if (query.from)
      base = base.where(
        sql<string>`(site_leads.created_at at time zone (select timezone from centres where id = site_leads.centre_id))::date`,
        ">=",
        query.from,
      );
    if (query.to)
      base = base.where(sql<string>`(site_leads.created_at at time zone (select timezone from centres where id = site_leads.centre_id))::date`, "<=", query.to);
    const rows = await base
      .select([
        "site_leads.id",
        "site_leads.kind",
        "site_leads.name",
        "site_leads.email",
        "site_leads.phone",
        "site_leads.company",
        "site_leads.message",
        "site_leads.preferred_date as preferredDate",
        "site_leads.page_path as pagePath",
        "site_leads.language",
        "site_leads.status",
        "site_leads.handled_at as handledAt",
        "users.full_name as handledBy",
        "site_leads.created_at as createdAt",
      ])
      .orderBy("site_leads.created_at", "desc")
      .orderBy("site_leads.id")
      .limit(query.pageSize + 1)
      .offset((query.page - 1) * query.pageSize)
      .execute();
    return { items: rows.slice(0, query.pageSize), hasMore: rows.length > query.pageSize, page: query.page };
  });

  app.patch("/leads/:id", { preHandler: leads }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = leadUpdate.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom("site_leads")
        .select(["id", "status"])
        .where("id", "=", id)
        .where("centre_id", "=", actor.centreId)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw notFound("lead");
      const handled = body.status !== "new";
      const after = await trx
        .updateTable("site_leads")
        .set({ status: body.status, handled_at: handled ? new Date() : null, handled_by: handled ? actor.userId : null })
        .where("id", "=", id)
        .returning(["id", "status", "handled_at as handledAt"])
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "site_lead.status_changed",
        objectType: "site_lead",
        objectId: id,
        before: { status: before.status },
        after: { status: after.status },
      });
      return after;
    });
  });
};
