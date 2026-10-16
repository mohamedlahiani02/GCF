import { FAQ_SECTION_TYPE, sectionMediaIds, type SiteLanguage, type SiteSection } from "@gcf/shared";
import { sql, type Kysely } from "kysely";
import type { Database, Module } from "../db/types.js";
import { loadSectionData } from "./dynamic.js";
import { SITE_LABELS } from "./labels.js";
import { loadLivePages, loadVersionContents, publicPath, slugChain, type LanguageContent, type PageRow, type VersionContent } from "./pages.js";
import { formatDate, renderDocument, renderSections, socialUrls, type MediaInfo, type MenuItem, type RenderContext } from "./render.js";
import type { SiteSettings } from "./settings.js";
import { esc } from "./html.js";

/** The client portal, served by this application under /espace/ on the public origin. */
export const PORTAL_PATH = "/espace/";

interface CentreInfo {
  id: string;
  name: string;
  address: string | null;
  modules: Module[];
  open_from: string;
  open_to: string;
  open_weekdays: number[];
}

/** A page visible on the public site, with the languages its published version holds. */
interface PublishedPage {
  page: PageRow;
  languages: SiteLanguage[];
  publishedAt: Date;
}

/** What one request needs to know about the site: settings, page tree and published pages. */
export interface SiteState {
  centre: CentreInfo;
  settings: SiteSettings;
  pages: PageRow[];
  byId: Map<string, PageRow>;
  published: Map<string, PublishedPage>;
  /** Published content of the pages shown in the menu and the footer. */
  navContents: Map<string, VersionContent>;
  coworking: boolean;
  bookingUrl: string | null;
}

/** Loads the site of a centre, or undefined when the website has never been configured. */
export async function loadSiteState(db: Kysely<Database>, centreId: string): Promise<SiteState | undefined> {
  const settings = await db.selectFrom("site_settings").selectAll().where("centre_id", "=", centreId).executeTakeFirst();
  if (!settings) return undefined;
  const centre = await db
    .selectFrom("centres")
    .select(["id", "name", "address", "modules", "open_from", "open_to", "open_weekdays"])
    .where("id", "=", centreId)
    .executeTakeFirstOrThrow();
  const pages = await loadLivePages(db, centreId);
  const versionIds = pages.filter((p) => p.status === "published" && p.published_version_id).map((p) => p.published_version_id!);
  const versions = versionIds.length
    ? await db
        .selectFrom("site_page_versions")
        .select(["id", "page_id", "created_at", sql<SiteLanguage[]>`array(select jsonb_object_keys(content -> 'languages'))`.as("languages")])
        .where("id", "in", versionIds)
        .execute()
    : [];
  const byId = new Map(pages.map((p) => [p.id, p]));
  const published = new Map<string, PublishedPage>();
  for (const v of versions) {
    const page = byId.get(v.page_id);
    if (page) published.set(page.id, { page, languages: v.languages.filter((l) => settings.languages.includes(l)), publishedAt: v.created_at });
  }
  const navIds = [...published.values()].filter((p) => p.page.show_in_menu || p.page.show_in_footer).map((p) => p.page.published_version_id!);
  const coworking = centre.modules.includes("coworking");
  const portal = coworking ? await db.selectFrom("cw_settings").select("portal_enabled").where("centre_id", "=", centreId).executeTakeFirst() : undefined;
  return {
    centre,
    settings,
    pages,
    byId,
    published,
    navContents: await loadVersionContents(db, navIds),
    coworking,
    bookingUrl: portal?.portal_enabled ? PORTAL_PATH : null,
  };
}

/** The public website answers only when the module is enabled and the site is switched online. */
export const siteOnline = (state: SiteState | undefined): state is SiteState => !!state && state.centre.modules.includes("website") && state.settings.online;

export function pathOf(state: SiteState, page: PageRow, language: SiteLanguage): string {
  return publicPath(slugChain(state.byId, page), language, state.settings.default_language);
}

export const homePath = (state: SiteState, language: SiteLanguage) => publicPath([], language, state.settings.default_language);

/** True when the page can be visited in that language on the public site. */
export function isPublic(state: SiteState, pageId: string, language: SiteLanguage): boolean {
  return state.published.get(pageId)?.languages.includes(language) ?? false;
}

function navItems(state: SiteState, language: SiteLanguage, currentId: string | null, flag: "show_in_menu" | "show_in_footer", parentId: string | null, depth: number): MenuItem[] {
  return state.pages
    .filter((p) => p.parent_id === parentId && p[flag] && isPublic(state, p.id, language))
    .map((p) => {
      const content = state.navContents.get(p.published_version_id!)?.[language];
      return {
        label: content?.menuLabel ?? content?.title ?? p.slug,
        path: pathOf(state, p, language),
        current: p.id === currentId,
        children: depth < 1 ? navItems(state, language, currentId, flag, p.id, depth + 1) : [],
      };
    });
}

async function loadMedia(db: Kysely<Database>, centreId: string, ids: readonly (string | null | undefined)[]): Promise<Map<string, MediaInfo>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .selectFrom("media_files")
    .select(["id", "mime", "width", "height", "alt"])
    .where("centre_id", "=", centreId)
    .where("id", "in", wanted)
    .execute();
  return new Map(rows.map((r) => [r.id, r]));
}

function openingHoursSpecification(centre: CentreInfo) {
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  return {
    "@type": "OpeningHoursSpecification",
    dayOfWeek: [...centre.open_weekdays].sort().map((d) => days[d - 1]),
    opens: centre.open_from.slice(0, 5),
    closes: centre.open_to.slice(0, 5),
  };
}

export interface PageRendering {
  page: PageRow;
  language: SiteLanguage;
  content: LanguageContent;
  /** Back-office preview of a draft: media through the staff API, no indexing, forms disabled. */
  preview: boolean;
  formStatus: "sent" | "error" | null;
  origin: string;
  now: Date;
}

/** Renders one page of the site as a complete HTML document. */
export async function renderSitePage(db: Kysely<Database>, state: SiteState, r: PageRendering): Promise<{ html: string; usesGoogleFonts: boolean }> {
  const { settings, centre } = state;
  const { page, language, content } = r;
  const labels = SITE_LABELS[language];
  const siteName = settings.site_name ?? centre.name;
  const path = pathOf(state, page, language);
  const sections: SiteSection[] = content.sections;

  const data = await loadSectionData(db, sections, {
    centreId: centre.id,
    coworking: state.coworking,
    language,
    defaultLanguage: settings.default_language,
    pages: state.pages,
    now: r.now,
  });
  const hero = sections.find((s) => s.type === "hero");
  const heroImage = hero?.type === "hero" ? hero.imageId : undefined;
  const media = await loadMedia(db, centre.id, [
    ...sectionMediaIds(sections),
    ...(data.spaces ?? []).map((s) => s.photoId),
    settings.logo_media_id,
    settings.favicon_media_id,
    content.ogMediaId,
  ]);
  const pagePaths = new Map(state.pages.filter((p) => isPublic(state, p.id, language)).map((p) => [p.id, pathOf(state, p, language)]));
  const ctx: RenderContext = {
    settings,
    language,
    labels,
    mediaUrl: (id) => (r.preview ? `/api/media/${id}/file` : `/media/${id}`),
    media,
    bookingUrl: state.bookingUrl,
    pagePaths,
    data,
    path,
    formStatus: r.formStatus,
    preview: r.preview,
  };

  const heroFirst = sections[0]?.type === "hero" && page.kind === "page";
  const pageHead = heroFirst
    ? ""
    : `<div class="wrap page-head"><h1>${esc(content.title)}</h1>${
        page.kind === "article" && page.article_date
          ? `<p class="meta"><time datetime="${esc(page.article_date)}">${esc(formatDate(page.article_date, language))}</time></p>`
          : ""
      }</div>`;
  const main = pageHead + renderSections(sections, ctx, centre.address);

  const languages = settings.languages;
  const available = languages.filter((l) => isPublic(state, page.id, l));
  const absolute = (p: string) => `${r.origin}${p}`;
  const alternates: { language: SiteLanguage | "x-default"; href: string }[] = [];
  if (!r.preview && available.length > 1) {
    for (const l of available) alternates.push({ language: l, href: absolute(pathOf(state, page, l)) });
    const fallback = available.includes(settings.default_language) ? settings.default_language : available[0]!;
    alternates.push({ language: "x-default", href: absolute(pathOf(state, page, fallback)) });
  }
  const ogMediaId = [content.ogMediaId, heroImage, settings.logo_media_id].find((id) => id && media.has(id));
  const description = content.seoDescription ?? settings.seo_description ?? settings.tagline;

  const jsonLd: unknown[] = [];
  if (page.is_home) {
    jsonLd.push({
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      name: siteName,
      url: absolute(path),
      ...(description ? { description } : {}),
      ...(settings.contact_phone ? { telephone: settings.contact_phone } : {}),
      ...(settings.contact_email ? { email: settings.contact_email } : {}),
      ...((settings.address ?? centre.address) ? { address: settings.address ?? centre.address } : {}),
      ...(settings.logo_media_id && media.has(settings.logo_media_id) ? { logo: absolute(`/media/${settings.logo_media_id}`) } : {}),
      ...(ogMediaId ? { image: absolute(`/media/${ogMediaId}`) } : {}),
      ...(settings.map_url ? { hasMap: settings.map_url } : {}),
      ...(socialUrls(settings).length ? { sameAs: socialUrls(settings) } : {}),
      openingHoursSpecification: [openingHoursSpecification(centre)],
    });
  }
  const faqs = sections.flatMap((s) => (s.type === FAQ_SECTION_TYPE ? s.items : []));
  if (faqs.length) {
    jsonLd.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.question, acceptedAnswer: { "@type": "Answer", text: f.answer } })),
    });
  }

  const html = renderDocument({
    ctx,
    centreName: centre.name,
    documentTitle: content.seoTitle ?? (page.is_home ? siteName : `${content.title} | ${siteName}`),
    description,
    canonical: r.preview ? null : absolute(path),
    alternates,
    ogType: page.kind === "article" ? "article" : "website",
    ogImage: ogMediaId && !r.preview ? absolute(`/media/${ogMediaId}`) : null,
    noindex: r.preview,
    jsonLd: r.preview ? [] : jsonLd,
    menu: navItems(state, language, page.id, "show_in_menu", null, 0),
    footerLinks: navItems(state, language, page.id, "show_in_footer", null, 1),
    languageLinks:
      languages.length > 1
        ? languages.map((l) => ({ language: l, href: isPublic(state, page.id, l) ? pathOf(state, page, l) : homePath(state, l), current: l === language }))
        : [],
    homePath: homePath(state, language),
    main,
  });
  return { html, usesGoogleFonts: settings.font === "plex" || settings.font === "inter" || settings.font === "poppins" };
}

/** The not-found page of an online site, with its header, menu and footer. */
export async function renderSiteNotFound(db: Kysely<Database>, state: SiteState, language: SiteLanguage): Promise<{ html: string; usesGoogleFonts: boolean }> {
  const { settings, centre } = state;
  const labels = SITE_LABELS[language];
  const media = await loadMedia(db, centre.id, [settings.logo_media_id, settings.favicon_media_id]);
  const ctx: RenderContext = {
    settings,
    language,
    labels,
    mediaUrl: (id) => `/media/${id}`,
    media,
    bookingUrl: state.bookingUrl,
    pagePaths: new Map(),
    data: { spaces: null, pricing: new Map(), availability: null, contact: null, articles: [] },
    path: homePath(state, language),
    formStatus: null,
    preview: false,
  };
  const home = homePath(state, language);
  const html = renderDocument({
    ctx,
    centreName: centre.name,
    documentTitle: `${labels.notFoundTitle} | ${settings.site_name ?? centre.name}`,
    description: null,
    canonical: null,
    alternates: [],
    ogType: "website",
    ogImage: null,
    noindex: true,
    jsonLd: [],
    menu: navItems(state, language, null, "show_in_menu", null, 0),
    footerLinks: navItems(state, language, null, "show_in_footer", null, 1),
    languageLinks: [],
    homePath: home,
    main: `<div class="wrap page-head"><h1>${esc(labels.notFoundTitle)}</h1><p>${esc(labels.notFoundText)}</p><p><a class="btn btn-primary" href="${esc(home)}">${esc(labels.backHome)}</a></p></div>`,
  });
  return { html, usesGoogleFonts: settings.font === "plex" || settings.font === "inter" || settings.font === "poppins" };
}

/** The not-found page when the site is not online: no theme, no menu, nothing to index. */
export function bareNotFound(language: SiteLanguage): string {
  const labels = SITE_LABELS[language];
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(
    labels.notFoundTitle,
  )}</title><style>body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:#fff;color:#111827;line-height:1.6}main{max-width:40rem;margin:15vh auto;padding:0 1.25rem}</style></head><body><main><h1>${esc(
    labels.notFoundTitle,
  )}</h1><p>${esc(labels.notFoundText)}</p></main></body></html>`;
}
