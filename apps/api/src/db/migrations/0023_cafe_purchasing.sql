-- Café: how a centre buys and prints is its own choice. Purchasing goes from a plain delivery, to deliveries
-- tied to a supplier, to purchase orders that are sent then received. Ticket printing is optional.

alter table cafe_settings
  add column ticket_printing text not null default 'none' check (ticket_printing in ('none', 'browser', 'thermal_58', 'thermal_80')),
  add column purchasing text not null default 'simple' check (purchasing in ('simple', 'suppliers', 'orders'));

create table cafe_suppliers (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  name text not null check (length(btrim(name)) > 0),
  phone text,
  email text,
  note text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index cafe_suppliers_name_idx on cafe_suppliers (centre_id, lower(name));

create table cafe_order_counters (
  centre_id uuid not null references centres (id),
  year integer not null,
  last_number integer not null,
  primary key (centre_id, year)
);

create table cafe_purchase_orders (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  number text not null,
  supplier_id uuid not null references cafe_suppliers (id),
  status text not null default 'draft' check (status in ('draft', 'ordered', 'received', 'cancelled')),
  note text,
  total bigint not null check (total >= 0),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  ordered_at timestamptz,
  received_at timestamptz,
  received_by uuid references users (id),
  cancelled_at timestamptz,
  cancel_reason text,
  unique (centre_id, number),
  check ((status = 'received') = (received_at is not null and received_by is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null and cancel_reason is not null))
);
create index cafe_purchase_orders_centre_idx on cafe_purchase_orders (centre_id, created_at desc);

create table cafe_purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references cafe_purchase_orders (id),
  product_id uuid not null references cafe_products (id),
  product_name text not null,
  quantity integer not null check (quantity > 0),
  unit_cost bigint not null check (unit_cost >= 0),
  unique (order_id, product_id)
);

alter table cafe_stock_movements
  add column supplier_id uuid references cafe_suppliers (id),
  add column purchase_order_id uuid references cafe_purchase_orders (id),
  add constraint cafe_stock_movements_purchase_refs check ((supplier_id is null and purchase_order_id is null) or kind = 'purchase');
