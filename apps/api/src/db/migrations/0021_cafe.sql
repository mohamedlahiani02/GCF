-- Café module: a point of sale with its own till, product catalogue and stock. The café till is separate from
-- the centre's cash journal: it has its own opening float, daily closing and differences.

alter table centres
  drop constraint centres_modules_known,
  add constraint centres_modules_known check (modules <@ array['training', 'coworking', 'website', 'cafe']::text[]);

create table cafe_settings (
  centre_id uuid primary key references centres (id),
  opening_float bigint not null default 0 check (opening_float >= 0),
  allow_negative_stock boolean not null default false,
  ticket_prefix text not null default 'CAF' check (ticket_prefix ~ '^[A-Z0-9]{1,8}$'),
  updated_by uuid references users (id),
  updated_at timestamptz not null default now()
);

create table cafe_products (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  name text not null check (length(btrim(name)) > 0),
  category text,
  price bigint not null check (price >= 0),
  track_stock boolean not null default true,
  stock_quantity integer not null default 0,
  low_stock_threshold integer check (low_stock_threshold >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index cafe_products_name_idx on cafe_products (centre_id, lower(name));

create table cafe_sale_counters (
  centre_id uuid not null references centres (id),
  year integer not null,
  last_number integer not null,
  primary key (centre_id, year)
);

create table cafe_sales (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  number text not null,
  day date not null,
  sold_at timestamptz not null default now(),
  method text not null check (method in ('cash', 'card')),
  total bigint not null check (total > 0),
  cash_received bigint check (cash_received >= total),
  status text not null default 'valid' check (status in ('valid', 'cancelled')),
  cancelled_at timestamptz,
  cancelled_by uuid references users (id),
  cancel_reason text,
  created_by uuid not null references users (id),
  unique (centre_id, number),
  check (cash_received is null or method = 'cash'),
  check ((status = 'cancelled') = (cancelled_at is not null and cancelled_by is not null and cancel_reason is not null))
);
create index cafe_sales_day_idx on cafe_sales (centre_id, day);

create table cafe_sale_lines (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references cafe_sales (id),
  centre_id uuid not null references centres (id),
  product_id uuid not null references cafe_products (id),
  product_name text not null,
  unit_price bigint not null check (unit_price >= 0),
  quantity integer not null check (quantity > 0),
  line_total bigint not null,
  check (line_total = unit_price * quantity)
);
create index cafe_sale_lines_sale_idx on cafe_sale_lines (sale_id);

-- Every change of a stock quantity, signed: purchases add, sales and losses remove, a count corrects.
create table cafe_stock_movements (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  product_id uuid not null references cafe_products (id),
  kind text not null check (kind in ('purchase', 'sale', 'sale_cancelled', 'loss', 'count')),
  quantity integer not null check (quantity <> 0),
  quantity_after integer not null,
  unit_cost bigint check (unit_cost >= 0),
  reason text,
  sale_id uuid references cafe_sales (id),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  check ((kind in ('sale', 'sale_cancelled')) = (sale_id is not null)),
  check (kind not in ('loss', 'count') or (reason is not null and length(btrim(reason)) > 0)),
  check (unit_cost is null or kind = 'purchase')
);
create index cafe_stock_movements_product_idx on cafe_stock_movements (product_id, created_at desc);

create function cafe_stock_movements_locked() returns trigger language plpgsql as $$
begin
  raise exception 'a stock movement is never changed (% not allowed)', tg_op using errcode = 'restrict_violation';
end;
$$;
create trigger cafe_stock_movements_no_update_delete before update or delete on cafe_stock_movements
  for each row execute function cafe_stock_movements_locked();

create table cafe_closings (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  day date not null,
  opening_float bigint not null check (opening_float >= 0),
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
create trigger cafe_closings_no_update_delete before update or delete on cafe_closings
  for each row execute function cash_closings_locked();
