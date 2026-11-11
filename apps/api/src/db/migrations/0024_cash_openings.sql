-- The cash put in a till in the morning, entered day by day: one for the centre's till (training, rentals,
-- coworking) and one for the café. A closing expects that float plus the day's cash takings, and keeps the float
-- it was computed with.

create table cash_openings (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  till text not null check (till in ('centre', 'cafe')),
  day date not null,
  amount bigint not null check (amount >= 0),
  opened_by uuid not null references users (id),
  opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (centre_id, till, day)
);

alter table cash_closings add column opening_float bigint not null default 0 check (opening_float >= 0);
