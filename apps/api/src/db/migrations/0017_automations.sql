-- Automations of the centre's routine work. Each one is a setting: off, propose (prepared, then confirmed by a person
-- in the proposals inbox) or auto (done without confirmation), with its own parameters. A missing row means off.
create table automation_settings (
  centre_id uuid not null references centres (id),
  key text not null check (key in ('overdue_reminders', 'payroll_month', 'daily_digest', 'mail_item_notice')),
  mode text not null check (mode in ('off', 'propose', 'auto')),
  params jsonb not null default '{}',
  updated_by uuid references users (id),
  updated_at timestamptz not null default now(),
  primary key (centre_id, key)
);

-- One row per scheduled run and period. The unique key is the claim: a period runs once even with several servers.
-- "skipped" marks the period in which an automation was switched on, so switching it on never fires at once.
create table automation_runs (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  key text not null,
  period_key text not null,
  mode text not null check (mode in ('propose', 'auto')),
  status text not null default 'running' check (status in ('running', 'done', 'failed', 'skipped')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  summary jsonb,
  error text,
  unique (centre_id, key, period_key)
);
create index automation_runs_recent_idx on automation_runs (centre_id, key, started_at desc);

-- Work an automation prepared for a person to confirm. Confirming runs it with that person's rights and name; a
-- newer proposal of the same kind replaces an older one that is still pending.
create table proposals (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  kind text not null check (kind in ('reminders.send', 'payroll.calculate')),
  title text not null,
  summary jsonb not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected', 'expired', 'failed')),
  run_id uuid references automation_runs (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  decided_by uuid references users (id),
  decided_at timestamptz,
  decision_note text,
  result jsonb,
  error text,
  check (expires_at > created_at),
  check ((status in ('confirmed', 'rejected', 'failed')) = (decided_at is not null))
);
create index proposals_pending_idx on proposals (centre_id, created_at desc) where status = 'pending';
create index proposals_recent_idx on proposals (centre_id, created_at desc);
