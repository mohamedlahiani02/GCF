-- Public website managed from the back-office: theme and identity, pages built from sections with a draft per
-- language and immutable published versions, redirects kept when a page moves, and visitor requests (leads).

create table site_settings (
  centre_id uuid primary key references centres (id),
  online boolean not null default false,
  theme text not null default 'corporate' check (theme in ('corporate', 'creative', 'minimal')),
  primary_color text not null default '#1d4ed8' check (primary_color ~ '^#[0-9a-f]{6}$'),
  secondary_color text not null default '#0f766e' check (secondary_color ~ '^#[0-9a-f]{6}$'),
  font text not null default 'system' check (font in ('system', 'serif', 'plex', 'inter', 'poppins')),
  radius text not null default 'small' check (radius in ('none', 'small', 'large')),
  color_scheme text not null default 'light' check (color_scheme in ('light', 'dark')),
  logo_media_id uuid references media_files (id),
  favicon_media_id uuid references media_files (id),
  languages text[] not null default '{fr}',
  default_language text not null default 'fr',
  site_name text,
  tagline text,
  contact_email text check (contact_email = lower(contact_email)),
  contact_phone text,
  address text,
  map_url text check (map_url ~ '^https://'),
  facebook_url text check (facebook_url ~ '^https://'),
  instagram_url text check (instagram_url ~ '^https://'),
  linkedin_url text check (linkedin_url ~ '^https://'),
  seo_description text,
  footer_text text,
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id),
  check (languages <@ array['fr', 'en']::text[] and cardinality(languages) >= 1),
  check (default_language = any (languages))
);

create table site_pages (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  kind text not null default 'page' check (kind in ('page', 'article')),
  is_home boolean not null default false,
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  parent_id uuid references site_pages (id),
  position integer not null default 0,
  show_in_menu boolean not null default false,
  show_in_footer boolean not null default false,
  article_date date,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  published_version_id uuid,
  scheduled_version_id uuid,
  scheduled_at timestamptz,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'article') = (article_date is not null)),
  check (not is_home or (parent_id is null and kind = 'page')),
  check ((scheduled_version_id is null) = (scheduled_at is null)),
  check (status <> 'published' or published_version_id is not null)
);
create unique index site_pages_home_key on site_pages (centre_id) where is_home and status <> 'archived';
create unique index site_pages_path_key on site_pages (centre_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), slug)
  where status <> 'archived';

-- The working copy edited in the back-office, one row per language.
create table site_page_drafts (
  page_id uuid not null references site_pages (id),
  language text not null check (language in ('fr', 'en')),
  title text not null check (length(btrim(title)) > 0),
  menu_label text,
  seo_title text,
  seo_description text,
  og_media_id uuid references media_files (id),
  sections jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id),
  primary key (page_id, language)
);

-- A published version freezes every language of the page. Restoring one copies it back into the drafts.
create table site_page_versions (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references site_pages (id),
  number integer not null check (number > 0),
  content jsonb not null,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  unique (page_id, number)
);

create function site_page_versions_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'site_page_versions are immutable (% not allowed)', tg_op using errcode = 'restrict_violation';
end;
$$;
create trigger site_page_versions_no_update_delete before update or delete on site_page_versions
  for each row execute function site_page_versions_immutable();

alter table site_pages add constraint site_pages_published_version_fkey foreign key (published_version_id) references site_page_versions (id);
alter table site_pages add constraint site_pages_scheduled_version_fkey foreign key (scheduled_version_id) references site_page_versions (id);

create table site_redirects (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  from_path text not null check (from_path ~ '^/[^?#]*$'),
  to_path text not null check (to_path ~ '^/[^?#]*$'),
  automatic boolean not null default false,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  check (from_path <> to_path)
);
create unique index site_redirects_from_key on site_redirects (centre_id, from_path);

create table site_leads (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  kind text not null check (kind in ('contact', 'visit', 'quote')),
  name text not null check (length(btrim(name)) > 0),
  email text check (email = lower(email)),
  phone text,
  company text,
  message text,
  preferred_date date,
  page_path text,
  language text not null check (language in ('fr', 'en')),
  status text not null default 'new' check (status in ('new', 'handled', 'spam')),
  handled_by uuid references users (id),
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  check (email is not null or phone is not null),
  check ((status = 'new') = (handled_at is null))
);
create index site_leads_centre_idx on site_leads (centre_id, created_at desc);
