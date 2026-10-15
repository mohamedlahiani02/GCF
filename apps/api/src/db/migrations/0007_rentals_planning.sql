-- Room tariffs, renters and rentals. Rentals book rooms through the same room_bookings table as sessions,
-- so a room can never be both rented and used for a class. Rental instalments and payments reuse the
-- generic resource + slot + tariff + payment machinery (also intended for coworking later).

create table room_rates (
  room_id uuid not null references rooms (id),
  unit text not null check (unit in ('hour', 'half_day', 'day', 'month', 'year')),
  amount bigint not null check (amount >= 0),
  primary key (room_id, unit)
);

create table renters (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  name text not null check (length(btrim(name)) > 0),
  company text,
  phone text,
  email text,
  created_at timestamptz not null default now()
);

create table rentals (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  renter_id uuid not null references renters (id),
  room_id uuid not null references rooms (id),
  unit text not null check (unit in ('hour', 'half_day', 'day', 'month', 'year')),
  quantity integer not null check (quantity > 0),
  unit_price bigint not null check (unit_price >= 0),
  total bigint not null check (total >= 0),
  payment_mode text not null check (payment_mode in ('full', 'deposit_balance', 'recurring')),
  status text not null default 'active' check (status in ('active', 'cancelled')),
  cancelled_at timestamptz,
  cancel_reason text,
  notes text,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  check ((status = 'cancelled') = (cancelled_at is not null and cancel_reason is not null))
);
create index rentals_room_idx on rentals (room_id);

create table rental_slots (
  id uuid primary key default gen_random_uuid(),
  rental_id uuid not null references rentals (id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  check (ends_at > starts_at)
);
create index rental_slots_rental_idx on rental_slots (rental_id);

alter table room_bookings add column rental_slot_id uuid references rental_slots (id);
alter table room_bookings add constraint room_bookings_one_source check ((session_id is null) <> (rental_slot_id is null));

alter table installments alter column enrolment_id drop not null;
alter table installments add column rental_id uuid references rentals (id);
alter table installments add constraint installments_one_owner check ((enrolment_id is null) <> (rental_id is null));
create index installments_rental_idx on installments (rental_id);

alter table payments add column renter_id uuid references renters (id);
alter table payments drop constraint payments_student_id_check;
alter table payments add constraint payments_one_payer check ((student_id is null) <> (renter_id is null));
create index payments_renter_idx on payments (renter_id);

alter table mail_dispatches add column renter_id uuid references renters (id);
alter table financial_events add column rental_id uuid references rentals (id);
alter table financial_events add column renter_id uuid references renters (id);
