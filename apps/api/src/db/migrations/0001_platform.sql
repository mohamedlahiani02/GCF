-- Platform foundation: centre, users, server-side sessions, immutable audit log, students.
-- Every business table carries centre_id so a second centre never requires a schema change.

create table centres (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) > 0),
  address text,
  tax_id text,
  currency text not null default 'TND',
  currency_decimals smallint not null default 3 check (currency_decimals between 0 and 3),
  locale text not null default 'fr' check (locale in ('fr', 'ar')),
  timezone text not null default 'Africa/Tunis',
  majority_age smallint not null default 18 check (majority_age between 1 and 30),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  email text not null check (email = lower(email) and length(email) between 3 and 254),
  full_name text not null check (length(btrim(full_name)) > 0),
  role text not null check (role in ('admin', 'secretariat', 'accountant')),
  password_hash text not null,
  active boolean not null default true,
  failed_login_count integer not null default 0 check (failed_login_count >= 0),
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index users_email_key on users (email);
create index users_centre_idx on users (centre_id);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  absolute_expires_at timestamptz not null,
  user_agent text
);
create index sessions_user_idx on sessions (user_id);

create table audit_log (
  id bigint generated always as identity primary key,
  centre_id uuid not null references centres (id),
  at timestamptz not null default now(),
  user_id uuid references users (id),
  action text not null,
  object_type text not null,
  object_id text not null,
  before jsonb,
  after jsonb,
  reason text
);
create index audit_log_centre_at_idx on audit_log (centre_id, at desc);
create index audit_log_object_idx on audit_log (centre_id, object_type, object_id);

create function audit_log_is_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only (% not allowed)', tg_op using errcode = 'restrict_violation';
end;
$$;
create trigger audit_log_no_update_delete before update or delete on audit_log
  for each row execute function audit_log_is_append_only();
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function audit_log_is_append_only();

create table students (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  first_name text not null check (length(btrim(first_name)) > 0),
  last_name text not null check (length(btrim(last_name)) > 0),
  birth_date date,
  phone text,
  email text,
  receipt_email text,
  guardian_name text,
  guardian_phone text,
  guardian_email text,
  notes text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references users (id)
);
create index students_centre_status_idx on students (centre_id, status);
create index students_name_idx on students (centre_id, lower(last_name), lower(first_name));
