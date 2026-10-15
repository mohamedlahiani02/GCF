-- Payments and their allocation to instalments, refunds, numbered immutable receipts, postponements,
-- reminders. Paid amounts are always derived from effective allocations, never stored.

alter table centres
  add column receipt_prefix text not null default 'REC' check (receipt_prefix ~ '^[A-Z0-9]{1,10}$'),
  add column receipt_footer text;

create table payments (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  kind text not null default 'payment' check (kind in ('payment', 'refund')),
  student_id uuid references students (id),
  received_at timestamptz not null default now(),
  amount bigint not null,
  method text not null check (method in ('cash', 'transfer', 'cheque', 'card')),
  cheque_number text,
  cheque_bank text,
  cheque_status text check (cheque_status in ('received', 'deposited', 'cashed', 'bounced')),
  reference text,
  note text,
  status text not null default 'valid' check (status in ('valid', 'cancelled')),
  cancelled_at timestamptz,
  cancelled_by uuid references users (id),
  cancel_reason text,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  check ((kind = 'payment' and amount > 0) or (kind = 'refund' and amount < 0)),
  check ((method = 'cheque') = (cheque_status is not null and cheque_number is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null and cancel_reason is not null)),
  check (student_id is not null)
);
create index payments_centre_received_idx on payments (centre_id, received_at desc);
create index payments_student_idx on payments (student_id);

-- A payment or an approved discount line pays an instalment.
create table allocations (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  payment_id uuid references payments (id),
  discount_id uuid references installments (id),
  installment_id uuid not null references installments (id),
  amount bigint not null check (amount > 0),
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  check ((payment_id is null) <> (discount_id is null))
);
create index allocations_payment_idx on allocations (payment_id);
create index allocations_discount_idx on allocations (discount_id);
create index allocations_installment_idx on allocations (installment_id);

-- Allocations that currently count: from a valid payment whose cheque did not bounce, or from an approved,
-- open discount.
create view effective_allocations as
  select a.*
  from allocations a
  left join payments p on p.id = a.payment_id
  left join installments d on d.id = a.discount_id
  where (p.id is not null and p.status = 'valid' and coalesce(p.cheque_status, 'cashed') <> 'bounced')
     or (d.id is not null and d.status = 'open' and d.discount_status = 'approved');

-- Never allocate more than an instalment, a payment or a discount is worth.
create function allocations_within_limits() returns trigger language plpgsql as $$
declare
  limit_amount bigint;
  used bigint;
begin
  select amount into limit_amount from installments where id = new.installment_id;
  select coalesce(sum(amount), 0) into used from effective_allocations where installment_id = new.installment_id;
  if used > limit_amount then
    raise exception 'instalment % over-allocated (% > %)', new.installment_id, used, limit_amount using errcode = 'check_violation';
  end if;
  if new.payment_id is not null then
    select amount into limit_amount from payments where id = new.payment_id;
    select coalesce(sum(amount), 0) into used from allocations where payment_id = new.payment_id;
  else
    select -amount into limit_amount from installments where id = new.discount_id;
    select coalesce(sum(amount), 0) into used from allocations where discount_id = new.discount_id;
  end if;
  if used > limit_amount then
    raise exception 'allocation source over-used (% > %)', used, limit_amount using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
create constraint trigger allocations_limits after insert on allocations
  deferrable initially deferred for each row execute function allocations_within_limits();

create table receipt_counters (
  centre_id uuid not null references centres (id),
  year integer not null,
  last_number integer not null check (last_number >= 0),
  primary key (centre_id, year)
);

create table receipts (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  number text not null,
  year integer not null,
  sequence integer not null,
  kind text not null check (kind in ('payment', 'refund', 'cancellation')),
  payment_id uuid not null references payments (id),
  cancels_receipt_id uuid references receipts (id),
  issued_at timestamptz not null default now(),
  snapshot jsonb not null,
  pdf bytea not null,
  sha256 text not null,
  created_by uuid references users (id),
  unique (centre_id, number),
  unique (centre_id, year, sequence)
);
create index receipts_payment_idx on receipts (payment_id);

create function receipts_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'receipts are immutable (% not allowed)', tg_op using errcode = 'restrict_violation';
end;
$$;
create trigger receipts_no_update_delete before update or delete on receipts
  for each row execute function receipts_immutable();

create table receipt_prints (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references receipts (id),
  printed_at timestamptz not null default now(),
  printed_by uuid references users (id),
  duplicate boolean not null
);

create table mail_dispatches (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  kind text not null check (kind in ('receipt', 'reminder')),
  receipt_id uuid references receipts (id),
  student_id uuid references students (id),
  recipient text not null,
  status text not null check (status in ('sent', 'failed')),
  error text,
  sent_at timestamptz not null default now(),
  sent_by uuid references users (id)
);
create index mail_dispatches_receipt_idx on mail_dispatches (receipt_id);

create table postponements (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  installment_id uuid not null references installments (id),
  from_date date not null,
  to_date date not null,
  reason text not null,
  requested_by uuid references users (id),
  requested_at timestamptz not null default now(),
  status text not null check (status in ('pending', 'approved', 'rejected')),
  decided_by uuid references users (id),
  decided_at timestamptz,
  decision_reason text,
  check (to_date > from_date)
);
create unique index postponements_pending_key on postponements (installment_id) where status = 'pending';
