-- Sellable modules, the website editor role, coworking members (clients of the portal) and their companies,
-- and the media library shared by the coworking plans and the public website.

-- Each centre runs the modules it subscribed to. Existing centres keep the training back-office.
alter table centres
  add column modules text[] not null default '{training}',
  add constraint centres_modules_known check (modules <@ array['training', 'coworking', 'website']::text[]);

alter table users drop constraint users_role_check;
alter table users add constraint users_role_check check (role in ('admin', 'secretariat', 'accountant', 'editor'));

create table companies (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  name text not null check (length(btrim(name)) > 0),
  tax_id text,
  address text,
  email text check (email = lower(email)),
  phone text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index companies_name_key on companies (centre_id, lower(name));

-- A member signs in to the portal. A guest is a walk-in client recorded at the desk without a portal account;
-- converting a guest into a member keeps the same row, so its history follows.
create table members (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  kind text not null check (kind in ('member', 'guest')),
  first_name text not null check (length(btrim(first_name)) > 0),
  last_name text,
  email text check (email = lower(email) and length(email) between 3 and 254),
  phone text,
  company_id uuid references companies (id),
  company_role text check (company_role in ('admin', 'member')),
  status text not null default 'active' check (status in ('pending', 'active', 'disabled')),
  password_hash text,
  email_verified_at timestamptz,
  failed_login_count integer not null default 0 check (failed_login_count >= 0),
  locked_until timestamptz,
  last_login_at timestamptz,
  notes text,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((company_id is null) = (company_role is null)),
  check (kind = 'member' or password_hash is null),
  check (password_hash is null or email is not null)
);
create unique index members_email_key on members (email) where email is not null;
create index members_centre_idx on members (centre_id, status);
create index members_name_idx on members (centre_id, lower(first_name), lower(coalesce(last_name, '')));
create index members_company_idx on members (company_id);

create table member_sessions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members (id) on delete cascade,
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  absolute_expires_at timestamptz not null,
  user_agent text
);
create index member_sessions_member_idx on member_sessions (member_id);

-- Single-use links sent by e-mail. Only the SHA-256 of the token is stored.
create table member_tokens (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members (id) on delete cascade,
  purpose text not null check (purpose in ('activation', 'password_reset')),
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index member_tokens_member_idx on member_tokens (member_id, purpose);

create table media_files (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  data bytea not null check (octet_length(data) <= 5242880),
  mime text not null check (mime in ('image/png', 'image/jpeg', 'image/webp')),
  bytes integer not null check (bytes > 0),
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  sha256 text not null,
  alt text,
  folder text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  check (bytes = octet_length(data))
);
create index media_files_centre_idx on media_files (centre_id, status, created_at desc);

-- Members pay like students and renters: exactly one payer per payment.
alter table payments add column member_id uuid references members (id);
alter table payments drop constraint payments_one_payer;
alter table payments add constraint payments_one_payer check (num_nonnulls(student_id, renter_id, member_id) = 1);
create index payments_member_idx on payments (member_id);

alter table mail_dispatches drop constraint mail_dispatches_kind_check;
alter table mail_dispatches add constraint mail_dispatches_kind_check
  check (kind in ('receipt', 'reminder', 'member_activation', 'password_reset', 'booking', 'mail_item', 'subscription'));
alter table mail_dispatches add column member_id uuid references members (id);
create index mail_dispatches_member_idx on mail_dispatches (member_id);

alter table financial_events add column member_id uuid references members (id);
