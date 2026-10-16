import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { SITE_LANGUAGES, type SiteLanguage } from "@gcf/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import { HttpError } from "../errors.js";
import { publicCentre, type PublicCentre } from "../publicCentre.js";
import { esc } from "./html.js";
import { readVersionContent } from "./pages.js";
import { contentSecurityPolicy } from "./render.js";
import {
  bareNotFound,
  homePath,
  isPublic,
  loadSiteState,
  pathOf,
  PORTAL_PATH,
  renderSiteNotFound,
  renderSitePage,
  siteOnline,
  type SiteState,
} from "./view.js";

const PAGE_CACHE = "public, max-age=60";
const IMMUTABLE = "public, max-age=31536000, immutable";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function sendHtml(reply: FastifyReply, status: number, html: string, usesGoogleFonts: boolean): FastifyReply {
  reply.status(status).header("content-type", "text/html; charset=utf-8").header("content-security-policy", contentSecurityPolicy(usesGoogleFonts));
  if (status === 404) reply.header("x-robots-tag", "noindex").header("cache-control", "no-cache");
  else reply.header("cache-control", PAGE_CACHE);
  return reply.send(html);
}

/** Language a path is written in, from its prefix, to word the not-found page. */
function languageOfPath(state: SiteState | undefined, pathname: string): SiteLanguage {
  const first = pathname.split("/")[1];
  const match = SITE_LANGUAGES.find((l) => l === first);
  if (match && (!state || state.settings.languages.includes(match))) return match;
  return state?.settings.default_language ?? "fr";
}

async function notFoundPage(app: FastifyInstance, reply: FastifyReply, state: SiteState | undefined, pathname: string): Promise<FastifyReply> {
  const language = languageOfPath(state, pathname);
  if (siteOnline(state)) {
    const page = await renderSiteNotFound(app.db, state, language);
    return sendHtml(reply, 404, page.html, page.usesGoogleFonts);
  }
  return sendHtml(reply, 404, bareNotFound(language), false);
}

/** Serves the built client portal: fingerprinted assets for good, every other route gets index.html revalidated. */
async function servePortal(app: FastifyInstance, reply: FastifyReply, centre: PublicCentre, pathname: string): Promise<FastifyReply | null> {
  const distDir = app.config.portalDistDir;
  if (!distDir || !centre.modules.includes("coworking")) return null;
  if (pathname === "/espace") return reply.redirect(PORTAL_PATH, 301);
  let relative: string;
  try {
    relative = decodeURIComponent(pathname.slice(PORTAL_PATH.length));
  } catch {
    return null;
  }
  if (relative.includes("\0") || relative.split(/[\\/]/).some((part) => part === "..")) return null;
  const root = path.resolve(distDir);
  const file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  const isAsset = file.startsWith(path.join(root, "assets") + path.sep);
  const info = relative === "" ? null : await stat(file).catch(() => null);
  if (info?.isFile()) {
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    return reply
      .header("content-type", type)
      .header("cache-control", isAsset ? IMMUTABLE : "no-cache")
      .send(createReadStream(file));
  }
  if (isAsset) return null;
  const index = path.join(root, "index.html");
  if (!(await stat(index).catch(() => null))?.isFile()) return null;
  return reply.header("content-type", CONTENT_TYPES[".html"]!).header("cache-control", "no-cache").send(createReadStream(index));
}

async function serveMedia(db: Kysely<Database>, reply: FastifyReply, centreId: string, id: string): Promise<FastifyReply | null> {
  if (!UUID.test(id)) return null;
  const row = await db.selectFrom("media_files").select(["data", "mime"]).where("id", "=", id).where("centre_id", "=", centreId).executeTakeFirst();
  if (!row) return null;
  return reply.header("content-type", row.mime).header("cache-control", IMMUTABLE).send(row.data);
}

function robots(origin: string, online: boolean): string {
  return online ? `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n` : "User-agent: *\nDisallow: /\n";
}

function sitemap(state: SiteState, origin: string): string {
  const urls: string[] = [];
  for (const { page, languages, publishedAt } of state.published.values()) {
    if (page.status !== "published") continue;
    const ordered = state.settings.languages.filter((l) => languages.includes(l));
    const alternates =
      ordered.length > 1 ? ordered.map((l) => `<xhtml:link rel="alternate" hreflang="${l}" href="${esc(origin + pathOf(state, page, l))}"/>`).join("") : "";
    for (const language of ordered) {
      urls.push(`<url><loc>${esc(origin + pathOf(state, page, language))}</loc><lastmod>${publishedAt.toISOString()}</lastmod>${alternates}</url>`);
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${urls.join("")}</urlset>\n`;
}

type Resolution = { kind: "page"; pageId: string; language: SiteLanguage } | { kind: "redirect"; to: string } | null;

/**
 * Finds the page a path designates: the default language at the root, the other enabled language under its
 * prefix. Paths that name a page in a non-canonical form (trailing slash, prefix of the default language, the
 * home page by its slug) redirect to the canonical path.
 */
function resolvePath(state: SiteState, pathname: string): Resolution {
  if (pathname !== "/" && pathname.endsWith("/")) return { kind: "redirect", to: pathname.replace(/\/+$/, "") || "/" };
  const segments = pathname.split("/").filter((s) => s !== "");
  if (segments.some((s) => !SEGMENT.test(s))) return null;
  const { languages, default_language: defaultLanguage } = state.settings;
  let language = defaultLanguage;
  const first = segments[0];
  if (first === defaultLanguage) return { kind: "redirect", to: `/${segments.slice(1).join("/")}` };
  if (first && languages.includes(first as SiteLanguage)) {
    language = first as SiteLanguage;
    segments.shift();
  }
  if (segments.length === 0) {
    const home = state.pages.find((p) => p.is_home);
    return home && isPublic(state, home.id, language) ? { kind: "page", pageId: home.id, language } : null;
  }
  let parentId: string | null = null;
  let found: SiteState["pages"][number] | undefined;
  for (const slug of segments) {
    found = state.pages.find((p) => p.parent_id === parentId && p.slug === slug);
    if (!found) return null;
    parentId = found.id;
  }
  if (!found || !isPublic(state, found.id, language)) return null;
  if (found.is_home) return { kind: "redirect", to: homePath(state, language) };
  return { kind: "page", pageId: found.id, language };
}

/** GET requests on the public origin that are not API calls: website pages, media, sitemap and the portal. */
export async function handlePublicGet(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const { db, config } = app;
  let centre: PublicCentre;
  try {
    centre = await publicCentre(db);
  } catch (error) {
    if (error instanceof HttpError) return reply.status(503).type("text/plain; charset=utf-8").header("cache-control", "no-store").send("Service unavailable");
    throw error;
  }
  const origin = config.publicOrigin!;
  const [rawPath = "/", rawQuery = ""] = request.url.split("?", 2);
  const pathname = rawPath.replace(/\/{2,}/g, "/");
  const query = new URLSearchParams(rawQuery);

  if (pathname === "/espace" || pathname.startsWith(PORTAL_PATH)) {
    const served = await servePortal(app, reply, centre, pathname);
    if (served) return served;
    return notFoundPage(app, reply, centre.modules.includes("website") ? await loadSiteState(db, centre.id) : undefined, pathname);
  }

  const media = /^\/media\/([^/]+)$/.exec(pathname);
  if (media) {
    const served = await serveMedia(db, reply, centre.id, media[1]!);
    if (served) return served;
    return reply.status(404).type("text/plain; charset=utf-8").send("Not found");
  }

  const state = centre.modules.includes("website") ? await loadSiteState(db, centre.id) : undefined;
  const online = siteOnline(state);

  if (pathname === "/robots.txt") {
    return reply.type("text/plain; charset=utf-8").header("cache-control", "public, max-age=300").send(robots(origin, online));
  }
  if (pathname === "/sitemap.xml") {
    if (!online) return reply.status(404).type("text/plain; charset=utf-8").send("Not found");
    return reply.type("application/xml; charset=utf-8").header("cache-control", "public, max-age=300").send(sitemap(state, origin));
  }

  if (!online) {
    if (pathname === "/" && centre.modules.includes("coworking")) return reply.header("cache-control", "no-cache").redirect(PORTAL_PATH, 302);
    return notFoundPage(app, reply, state, pathname);
  }

  const resolution = resolvePath(state, pathname);
  if (resolution?.kind === "redirect") return reply.redirect(resolution.to + (rawQuery ? `?${rawQuery}` : ""), 301);
  if (resolution?.kind === "page") {
    const page = state.byId.get(resolution.pageId)!;
    const version = await db.selectFrom("site_page_versions").select("content").where("id", "=", page.published_version_id!).executeTakeFirstOrThrow();
    const content = readVersionContent(version.content)[resolution.language]!;
    const formStatus = query.get("envoye") === "1" ? "sent" : query.get("erreur") === "1" ? "error" : null;
    const rendered = await renderSitePage(db, state, { page, language: resolution.language, content, preview: false, formStatus, origin, now: new Date() });
    return sendHtml(reply, 200, rendered.html, rendered.usesGoogleFonts);
  }

  const redirect = await db
    .selectFrom("site_redirects")
    .select("to_path")
    .where("centre_id", "=", centre.id)
    .where("from_path", "=", pathname)
    .executeTakeFirst();
  if (redirect) return reply.redirect(redirect.to_path, 301);
  return notFoundPage(app, reply, state, pathname);
}
