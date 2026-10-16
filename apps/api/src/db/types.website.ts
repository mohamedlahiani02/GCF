import type { ColumnType, Generated } from "kysely";
import type { NullableDate, NullableTimestamp, Timestamp } from "./types.js";

export type SiteLanguage = "fr" | "en";
export type SiteTheme = "corporate" | "creative" | "minimal";
export type SiteFont = "system" | "serif" | "plex" | "inter" | "poppins";

export interface SiteSettingsTable {
  centre_id: string;
  online: Generated<boolean>;
  theme: Generated<SiteTheme>;
  primary_color: Generated<string>;
  secondary_color: Generated<string>;
  font: Generated<SiteFont>;
  radius: Generated<"none" | "small" | "large">;
  color_scheme: Generated<"light" | "dark">;
  logo_media_id: string | null;
  favicon_media_id: string | null;
  languages: Generated<SiteLanguage[]>;
  default_language: Generated<SiteLanguage>;
  site_name: string | null;
  tagline: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  address: string | null;
  map_url: string | null;
  facebook_url: string | null;
  instagram_url: string | null;
  linkedin_url: string | null;
  seo_description: string | null;
  footer_text: string | null;
  updated_at: Timestamp;
  updated_by: string | null;
}

export interface SitePagesTable {
  id: Generated<string>;
  centre_id: string;
  kind: Generated<"page" | "article">;
  is_home: Generated<boolean>;
  slug: string;
  parent_id: string | null;
  position: Generated<number>;
  show_in_menu: Generated<boolean>;
  show_in_footer: Generated<boolean>;
  article_date: NullableDate;
  status: Generated<"draft" | "published" | "archived">;
  published_version_id: string | null;
  scheduled_version_id: string | null;
  scheduled_at: NullableTimestamp;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SitePageDraftsTable {
  page_id: string;
  language: SiteLanguage;
  title: string;
  menu_label: string | null;
  seo_title: string | null;
  seo_description: string | null;
  og_media_id: string | null;
  sections: ColumnType<unknown, string | undefined, string>;
  updated_at: Timestamp;
  updated_by: string | null;
}

export interface SitePageVersionsTable {
  id: Generated<string>;
  page_id: string;
  number: number;
  content: ColumnType<unknown, string, never>;
  created_by: string | null;
  created_at: Timestamp;
}

export interface SiteRedirectsTable {
  id: Generated<string>;
  centre_id: string;
  from_path: string;
  to_path: string;
  automatic: Generated<boolean>;
  created_by: string | null;
  created_at: Timestamp;
}

export interface SiteLeadsTable {
  id: Generated<string>;
  centre_id: string;
  kind: "contact" | "visit" | "quote";
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  message: string | null;
  preferred_date: NullableDate;
  page_path: string | null;
  language: SiteLanguage;
  status: Generated<"new" | "handled" | "spam">;
  handled_by: string | null;
  handled_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface WebsiteTables {
  site_settings: SiteSettingsTable;
  site_pages: SitePagesTable;
  site_page_drafts: SitePageDraftsTable;
  site_page_versions: SitePageVersionsTable;
  site_redirects: SiteRedirectsTable;
  site_leads: SiteLeadsTable;
}
