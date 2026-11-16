-- Invoices and credit notes. An invoice gathers charges already due by one payer (enrolment instalments, room
-- rentals, coworking bookings, subscriptions, packs); it does not create debt, it documents it. What is paid stays
-- in the ledger: an invoice is paid when the charges it lists are. A wrong invoice is never changed or deleted: a
-- credit note cancels it in full and its charges can be invoiced again.

alter table centres
  add column invoice_prefix text not null default 'FA' check (invoice_prefix ~ '^[A-Z0-9-]{1,10}$'),
  add column credit_note_prefix text not null default 'AV' check (credit_note_prefix ~ '^[A-Z0-9-]{1,10}$'),
  -- Rate shown to companies: prices stay all taxes included, the invoice of a company splits them. Null shows none.
  add column invoice_tax_bp integer check (invoice_tax_bp between 1 and 10000),
  add column invoice_due_days integer not null default 15 check (invoice_due_days between 0 and 180),
  add column invoice_footer text check (length(invoice_footer) <= 2000);

-- Gap-free numbering per centre, kind and year: the row is locked and rolls back with the transaction.
create table invoice_counters (
  centre_id uuid not null references centres (id),
  kind text not null check (kind in ('invoice', 'credit_note')),
  year integer not null,
  last_number integer not null check (last_number >= 0),
  primary key (centre_id, kind, year)
);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  kind text not null check (kind in ('invoice', 'credit_note')),
  number text not null,
  year integer not null,
  sequence integer not null,
  student_id uuid references students (id),
  renter_id uuid references renters (id),
  member_id uuid references members (id),
  credits_invoice_id uuid references invoices (id),
  issue_date date not null,
  due_date date,
  -- Everything printed, frozen when issued: centre, buyer, lines, totals.
  snapshot jsonb not null,
  total bigint not null,
  net bigint not null,
  tax bigint not null,
  tax_bp integer,
  status text not null default 'issued' check (status in ('issued', 'credited')),
  credit_reason text,
  sent_at timestamptz,
  sent_to text,
  sent_by uuid references users (id),
  pdf bytea not null,
  sha256 text not null,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  unique (centre_id, number),
  unique (centre_id, kind, year, sequence),
  check (num_nonnulls(student_id, renter_id, member_id) = 1),
  check ((kind = 'credit_note') = (credits_invoice_id is not null)),
  check ((kind = 'invoice' and total > 0 and due_date is not null) or (kind = 'credit_note' and total < 0 and due_date is null)),
  check (total = net + tax),
  check (kind = 'invoice' or status = 'issued'),
  check ((status = 'credited') = (credit_reason is not null))
);
create index invoices_centre_date_idx on invoices (centre_id, issue_date desc);
create unique index invoices_one_credit_note on invoices (credits_invoice_id) where credits_invoice_id is not null;

-- Only the delivery and the crediting of an issued document may change; nothing is ever deleted.
create function invoices_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'invoices cannot be deleted' using errcode = 'restrict_violation';
  end if;
  if (new.number, new.kind, new.total, new.net, new.tax, new.snapshot, new.pdf, new.issue_date, new.due_date)
     is distinct from (old.number, old.kind, old.total, old.net, old.tax, old.snapshot, old.pdf, old.issue_date, old.due_date)
     or (old.status = 'credited' and new.status <> 'credited') then
    raise exception 'an issued invoice cannot be changed' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
create trigger invoices_guard before update or delete on invoices for each row execute function invoices_guard();

-- The charges an invoice lists. A charge is on at most one invoice that has not been credited.
create table invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices (id),
  installment_id uuid not null references installments (id),
  amount bigint not null check (amount > 0),
  active boolean not null default true
);
create unique index invoice_items_one_active on invoice_items (installment_id) where active;
create index invoice_items_invoice_idx on invoice_items (invoice_id);

alter table mail_dispatches drop constraint mail_dispatches_kind_check;
alter table mail_dispatches add constraint mail_dispatches_kind_check
  check (kind in ('receipt', 'reminder', 'member_activation', 'password_reset', 'booking', 'mail_item', 'subscription', 'invoice'));
alter table mail_dispatches add column invoice_id uuid references invoices (id);
