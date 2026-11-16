-- Visitor register: a client announces a guest from the portal, or the front desk enters one; the desk records the
-- arrival and the departure and the host is told by e-mail when the guest arrives. Guests are not clients: only what
-- the desk needs is kept, and entries are deleted after the centre's retention period.
create table cw_visitors (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  host_member_id uuid not null references members (id),
  name text not null check (length(btrim(name)) between 1 and 120),
  company text check (length(company) <= 120),
  phone text check (length(phone) <= 40),
  expected_on date not null,
  expected_at time,
  purpose text check (length(purpose) <= 200),
  status text not null default 'expected' check (status in ('expected', 'arrived', 'left', 'cancelled')),
  announced_by text not null check (announced_by in ('portal', 'staff')),
  arrived_at timestamptz,
  left_at timestamptz,
  cancelled_at timestamptz,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  check ((status in ('arrived', 'left')) = (arrived_at is not null)),
  check ((status = 'left') = (left_at is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create index cw_visitors_day_idx on cw_visitors (centre_id, expected_on);
create index cw_visitors_host_idx on cw_visitors (host_member_id);

alter table cw_settings
  add column visitor_retention_days integer not null default 90 check (visitor_retention_days between 1 and 1095),
  add column visitor_notify_host boolean not null default true;

alter table mail_dispatches drop constraint mail_dispatches_kind_check;
alter table mail_dispatches add constraint mail_dispatches_kind_check
  check (kind in ('receipt', 'reminder', 'member_activation', 'password_reset', 'booking', 'mail_item', 'subscription', 'invoice', 'visitor'));
