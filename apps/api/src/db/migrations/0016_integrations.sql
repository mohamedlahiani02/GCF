-- Integrations with outside tools (n8n and others): access tokens for the API, and signed webhooks that carry
-- every audited change out of the application.

-- An access token acts for the administrator who created it, with its own role, which is never admin. Only the
-- SHA-256 hash of the token is stored; the token itself is shown once, at creation.
create table api_tokens (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  name text not null check (length(btrim(name)) between 1 and 100),
  role text not null check (role in ('secretariat', 'accountant', 'editor')),
  read_only boolean not null default true,
  token_hash bytea not null unique,
  token_prefix text not null,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references users (id),
  check (expires_at is null or expires_at > created_at),
  check ((revoked_at is null) = (revoked_by is null))
);
create index api_tokens_centre_idx on api_tokens (centre_id, created_at desc);

-- Which token, if any, made the change. user_id stays the administrator the token acts for.
alter table audit_log add column api_token_id uuid references api_tokens (id);

-- A destination for events. The secret signs every delivery (HMAC-SHA256); the receiver checks it.
create table webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  name text not null check (length(btrim(name)) between 1 and 100),
  url text not null check (url ~ '^https?://' and length(url) <= 2000),
  secret text not null check (length(secret) >= 32),
  events text[] not null check (cardinality(events) between 1 and 100),
  active boolean not null default true,
  max_attempts integer not null default 10 check (max_attempts between 1 and 20),
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index webhook_endpoints_centre_idx on webhook_endpoints (centre_id) where active;

-- An event pattern is an exact action ("payment.created"), a family ("payment.*") or everything ("*").
create function webhook_event_matches(patterns text[], action text) returns boolean language sql immutable as $$
  select exists (
    select 1 from unnest(patterns) as p
    where p = '*' or p = action or (right(p, 2) = '.*' and starts_with(action, left(p, -1)))
  )
$$;

-- One row per event and endpoint. A ping (connection test) has no audit row.
create table webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  endpoint_id uuid not null references webhook_endpoints (id) on delete cascade,
  audit_id bigint references audit_log (id),
  event_type text not null,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  last_status_code integer,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  check ((audit_id is null) = (event_type = 'ping')),
  unique (endpoint_id, audit_id)
);
create index webhook_deliveries_due_idx on webhook_deliveries (next_attempt_at) where status = 'pending';
create index webhook_deliveries_endpoint_idx on webhook_deliveries (endpoint_id, created_at desc);
create index webhook_deliveries_created_idx on webhook_deliveries (created_at);

-- The delivery is queued in the same transaction as the audited change, so an event is never lost and never
-- sent for a change that was rolled back.
create function enqueue_webhook_deliveries() returns trigger language plpgsql as $$
begin
  insert into webhook_deliveries (centre_id, endpoint_id, audit_id, event_type)
  select e.centre_id, e.id, new.id, new.action
  from webhook_endpoints e
  where e.centre_id = new.centre_id and e.active and webhook_event_matches(e.events, new.action);
  return null;
end;
$$;
create trigger audit_log_enqueue_webhooks after insert on audit_log
  for each row execute function enqueue_webhook_deliveries();
