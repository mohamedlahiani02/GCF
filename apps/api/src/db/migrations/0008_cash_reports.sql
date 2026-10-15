-- Daily cash closing (locked once saved) and the opening hours used for room occupancy rates.

alter table centres
  add column open_from time not null default '08:00',
  add column open_to time not null default '20:00',
  add column open_weekdays smallint[] not null default '{1,2,3,4,5,6}',
  add constraint centres_opening_hours check (open_to > open_from);

create table cash_closings (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  day date not null,
  expected_cash bigint not null,
  counted_cash bigint not null check (counted_cash >= 0),
  difference bigint not null,
  comment text,
  totals jsonb not null,
  closed_by uuid not null references users (id),
  closed_at timestamptz not null default now(),
  unique (centre_id, day),
  check (difference = counted_cash - expected_cash),
  check (difference = 0 or (comment is not null and length(btrim(comment)) > 0))
);

create function cash_closings_locked() returns trigger language plpgsql as $$
begin
  raise exception 'a cash closing is locked (% not allowed)', tg_op using errcode = 'restrict_violation';
end;
$$;
create trigger cash_closings_no_update_delete before update or delete on cash_closings
  for each row execute function cash_closings_locked();
