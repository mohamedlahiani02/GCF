-- Options a client adds to a booking of a resource type (screen, coffee break, extra chair). The price is all taxes
-- included, like the formats: fixed per booking, per person attending, or per item ordered. Subscribers may get
-- their own price; without one they pay the general price.
create table cw_extras (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  type_id uuid not null references cw_resource_types (id),
  name text not null check (length(btrim(name)) > 0),
  pricing text not null check (pricing in ('fixed', 'per_person', 'per_item')),
  amount bigint not null check (amount >= 0),
  member_amount bigint check (member_amount >= 0),
  max_quantity integer not null default 1 check (max_quantity between 1 and 500),
  public boolean not null default true,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  check (pricing <> 'fixed' or max_quantity = 1)
);
create unique index cw_extras_name_key on cw_extras (centre_id, type_id, lower(name));

-- What a booking took, priced when it was made: later price changes do not touch past bookings.
create table cw_booking_extras (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  booking_id uuid not null references cw_bookings (id) on delete cascade,
  extra_id uuid not null references cw_extras (id),
  name text not null,
  pricing text not null check (pricing in ('fixed', 'per_person', 'per_item')),
  quantity integer not null check (quantity >= 1),
  unit_amount bigint not null check (unit_amount >= 0),
  amount bigint not null check (amount = unit_amount * quantity),
  unique (booking_id, extra_id)
);

-- The extras are part of the charge; coverage and promotion codes apply to the place only.
do $$
declare
  rule text;
begin
  select conname into rule from pg_constraint
  where conrelid = 'cw_bookings'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) like '%charge = ((list_price - promo_discount) - coverage_discount)%';
  if rule is not null then
    execute format('alter table cw_bookings drop constraint %I', rule);
  end if;
end $$;

alter table cw_bookings
  add column extras_total bigint not null default 0 check (extras_total >= 0),
  add constraint cw_bookings_charge_parts check (charge = list_price - promo_discount - coverage_discount + extras_total);
