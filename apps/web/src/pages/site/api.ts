import type { LeadKind, SiteLanguage, SiteSection } from "@gcf/shared";
import { api } from "../../api/client";
import type { Tone } from "../../lib/labels";

/** Shapes returned by /api/site and /api/media, and the vocabulary shared by the website screens. */

export type PageStatus = "draft" | "published" | "archived";
export type SiteTheme = "corporate" | "creative" | "minimal";
export type SiteFont = "system" | "serif" | "plex" | "inter" | "poppins";
export type SiteRadius = "none" | "small" | "large";
export type ColorScheme = "light" | "dark";
export type LeadStatus = "new" | "handled" | "spam";

export interface SiteSettings {
  online: boolean;
  theme: SiteTheme;
  primaryColor: string;
  secondaryColor: string;
  font: SiteFont;
  radius: SiteRadius;
  colorScheme: ColorScheme;
  logoMediaId: string | null;
  faviconMediaId: string | null;
  languages: SiteLanguage[];
  defaultLanguage: SiteLanguage;
  siteName: string | null;
  tagline: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  mapUrl: string | null;
  facebookUrl: string | null;
  instagramUrl: string | null;
  linkedinUrl: string | null;
  seoDescription: string | null;
  footerText: string | null;
  updatedAt: string;
}

export interface PageNode {
  id: string;
  kind: "page" | "article";
  slug: string;
  parentId: string | null;
  position: number;
  isHome: boolean;
  showInMenu: boolean;
  showInFooter: boolean;
  articleDate: string | null;
  status: PageStatus;
  scheduledAt: string | null;
  updatedAt: string;
  path: string;
  titles: Partial<Record<SiteLanguage, string>>;
  publishedVersion: number | null;
  scheduledVersion: number | null;
  children: PageNode[];
}

export interface Draft {
  language: SiteLanguage;
  title: string;
  menuLabel: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  ogMediaId: string | null;
  sections: SiteSection[];
  updatedAt: string | null;
}

export interface PageVersion {
  id: string;
  number: number;
  createdAt: string;
  createdBy: string | null;
  published: boolean;
  scheduled: boolean;
  titles: Partial<Record<SiteLanguage, string>>;
}

export interface MediaFile {
  id: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  alt: string | null;
  folder: string | null;
  status: "active" | "archived";
  createdAt: string;
  url: string;
}

export interface MediaList {
  items: MediaFile[];
  hasMore: boolean;
  page: number;
}

export interface Redirect {
  id: string;
  fromPath: string;
  toPath: string;
  automatic: boolean;
  createdAt: string;
}

export interface Lead {
  id: string;
  kind: LeadKind;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  message: string | null;
  preferredDate: string | null;
  pagePath: string | null;
  language: SiteLanguage;
  status: LeadStatus;
  handledAt: string | null;
  handledBy: string | null;
  createdAt: string;
}

export interface LeadList {
  items: Lead[];
  hasMore: boolean;
  page: number;
}

export const siteKeys = {
  all: ["site"] as const,
  settings: ["site", "settings"] as const,
  pages: ["site", "pages"] as const,
  draft: (id: string, language: SiteLanguage) => ["site", "draft", id, language] as const,
  versions: (id: string) => ["site", "versions", id] as const,
  media: ["site", "media"] as const,
  redirects: ["site", "redirects"] as const,
  leads: ["site", "leads"] as const,
};

export const fetchSettings = () => api.get<SiteSettings>("/site/settings");
export const fetchPages = () => api.get<PageNode[]>("/site/pages");

export const LANGUAGE_LABEL: Record<SiteLanguage, string> = { fr: "Français", en: "Anglais" };

export const PAGE_STATUS: Record<PageStatus, { label: string; tone: Tone }> = {
  draft: { label: "Brouillon", tone: "neutral" },
  published: { label: "Publiée", tone: "green" },
  archived: { label: "Archivée", tone: "gray" },
};

export const LEAD_KIND: Record<LeadKind, string> = { contact: "Contact", visit: "Demande de visite", quote: "Demande de devis" };
export const LEAD_STATUS: Record<LeadStatus, { label: string; tone: Tone }> = {
  new: { label: "Nouvelle", tone: "amber" },
  handled: { label: "Traitée", tone: "green" },
  spam: { label: "Indésirable", tone: "gray" },
};

/** Address of a media file for the back-office (the site serves it under its own path). */
export const mediaFileUrl = (id: string) => api.fileUrl(`/media/${id}/file`);

/** Title of a page in the default language, falling back to any language, then to its address. */
export function pageTitle(page: PageNode, language: SiteLanguage): string {
  return page.titles[language] || Object.values(page.titles).find(Boolean) || page.slug;
}

/** Pages of the tree in display order, each with its depth (0 for the top level). */
export function flattenPages(nodes: readonly PageNode[], depth = 0): { page: PageNode; depth: number }[] {
  return nodes.flatMap((page) => [{ page, depth }, ...flattenPages(page.children, depth + 1)]);
}

/** A page and every page under it. */
export function subtreeIds(page: PageNode): string[] {
  return [page.id, ...page.children.flatMap(subtreeIds)];
}

/** URL segment proposed from a title: lowercase ASCII letters, digits and hyphens, as the API requires. */
export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
}

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Contrast ratio between white text and a #rrggbb colour, computed like the API (WCAG 2) to warn before saving. */
export function contrastWithWhite(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return 1.05 / (0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b) + 0.05);
}

/** Minimum contrast the API requires for white text on the theme colours. */
export const MIN_CONTRAST = 4.5;

export const ratioText = (ratio: number) => `${ratio.toFixed(2).replace(".", ",")}:1`;
