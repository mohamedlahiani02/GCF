-- Instructor pay is no longer validated month by month for everyone at once. Each rule produces pay items
-- ("éléments de rémunération") at its own rhythm: one per held session, one per month, or one per training group.
-- Items are calculated, validated and settled independently, per instructor; a settlement can pay several items,
-- in full or in part. Nothing is ever deleted: a recalculation or a correction cancels the old item with a reason.

alter table pay_rules
  add column periodicity text check (periodicity in ('session', 'month', 'training'));
update pay_rules set periodicity = case
  when base_kind in ('fixed_per_session', 'pct_session_tariff') then 'session'
  when base_kind = 'training_flat' then 'training'
  else 'month'
end;
alter table pay_rules
  alter column periodicity set not null,
  add constraint pay_rules_periodicity_rule check (
    (base_kind in ('fixed_per_session', 'pct_session_tariff', 'hourly') and periodicity in ('session', 'month'))
    or (base_kind in ('pct_collections', 'monthly_flat') and periodicity = 'month')
    or (base_kind = 'training_flat' and periodicity = 'training')
  );

create table pay_items (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  instructor_id uuid not null references instructors (id),
  kind text not null check (kind in ('rule', 'bonus', 'deduction')),
  rule_id uuid references pay_rules (id),
  -- The rule as it stood when the item was calculated: later rule changes never alter an item.
  rule_snapshot jsonb,
  group_id uuid references groups (id),
  -- What the item pays for: 'session:<id>', 'month:YYYY-MM', 'training:<group id>' or 'adjustment:<id>'.
  period_key text not null,
  period_start date not null,
  period_end date not null,
  -- The first day the item may be validated (the session date, the last day of the month, the end of the group).
  due_on date not null,
  label text not null check (length(btrim(label)) > 0),
  base bigint not null default 0,
  rate_numerator integer not null default 1,
  rate_denominator integer not null default 1 check (rate_denominator > 0),
  -- Signed: a deduction is negative.
  amount bigint not null,
  details jsonb not null default '{}',
  status text not null default 'calculated' check (status in ('calculated', 'validated', 'cancelled')),
  reason text,
  calculated_at timestamptz not null default now(),
  calculated_by uuid references users (id),
  validated_at timestamptz,
  validated_by uuid references users (id),
  cancelled_at timestamptz,
  cancelled_by uuid references users (id),
  cancel_reason text,
  check (period_end >= period_start),
  check ((kind = 'rule') = (rule_id is not null and rule_snapshot is not null)),
  check (kind = 'rule' or (reason is not null and length(btrim(reason)) > 0)),
  check ((kind = 'bonus' and amount > 0) or (kind = 'deduction' and amount < 0) or (kind = 'rule' and amount >= 0)),
  check ((status = 'validated') = (validated_at is not null) or status = 'cancelled'),
  check ((status = 'cancelled') = (cancelled_at is not null and cancel_reason is not null))
);
create index pay_items_instructor_idx on pay_items (centre_id, instructor_id, status, period_end);
-- A prestation is calculated once: a second active item for the same rule, group and period is refused.
create unique index pay_items_once on pay_items (instructor_id, rule_id, coalesce(group_id, '00000000-0000-0000-0000-000000000000'::uuid), period_key)
  where status <> 'cancelled' and kind = 'rule';

-- Sessions an item pays for. A held session is paid to its instructor by at most one active item.
create table pay_item_sessions (
  item_id uuid not null references pay_items (id),
  session_id uuid not null references class_sessions (id),
  instructor_id uuid not null references instructors (id),
  active boolean not null default true,
  primary key (item_id, session_id)
);
create unique index pay_item_sessions_once on pay_item_sessions (session_id, instructor_id) where active;

create table pay_settlement_counters (
  centre_id uuid not null references centres (id),
  year integer not null,
  last_number integer not null check (last_number >= 0),
  primary key (centre_id, year)
);

-- A payment to one instructor covering one or more validated items, with its numbered proof of payment.
create table pay_settlements (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  instructor_id uuid not null references instructors (id),
  number text not null,
  paid_on date not null,
  method text not null check (method in ('cash', 'transfer', 'cheque')),
  reference text,
  amount bigint not null check (amount > 0),
  pdf bytea not null,
  sha256 text not null,
  status text not null default 'valid' check (status in ('valid', 'cancelled')),
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid references users (id),
  cancel_reason text,
  unique (centre_id, number),
  check ((status = 'cancelled') = (cancelled_at is not null and cancel_reason is not null))
);
create index pay_settlements_instructor_idx on pay_settlements (centre_id, instructor_id, paid_on);

create table pay_settlement_lines (
  settlement_id uuid not null references pay_settlements (id),
  item_id uuid not null references pay_items (id),
  amount bigint not null check (amount <> 0),
  primary key (settlement_id, item_id)
);
create index pay_settlement_lines_item_idx on pay_settlement_lines (item_id);

-- An item is never paid beyond its amount, whatever the number of settlements.
create function pay_item_settled_within_amount() returns trigger language plpgsql as $$
declare
  item_amount bigint;
  item_status text;
  settled bigint;
begin
  select amount, status into item_amount, item_status from pay_items where id = new.item_id;
  if item_status <> 'validated' then
    raise exception 'pay item % is not validated', new.item_id using errcode = 'check_violation';
  end if;
  select coalesce(sum(l.amount), 0) into settled
    from pay_settlement_lines l join pay_settlements s on s.id = l.settlement_id
    where l.item_id = new.item_id and s.status = 'valid';
  if (item_amount >= 0 and (settled < 0 or settled > item_amount)) or (item_amount < 0 and (settled > 0 or settled < item_amount)) then
    raise exception 'pay item % over-settled (% of %)', new.item_id, settled, item_amount using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
create constraint trigger pay_settlement_lines_limit after insert on pay_settlement_lines
  deferrable initially deferred for each row execute function pay_item_settled_within_amount();

-- Existing payroll carried over: validated or paid months become validated items, with their sessions, their
-- adjustments and, for paid payslips, a settlement keeping the original payslip as its proof. Months still in
-- draft or calculated are simply recalculated under the new model.
insert into pay_items (id, centre_id, instructor_id, kind, rule_id, rule_snapshot, group_id, period_key, period_start, period_end, due_on,
                       label, base, rate_numerator, rate_denominator, amount, details, status, calculated_at, validated_at, validated_by)
select l.id, p.centre_id, l.instructor_id, 'rule', l.rule_id, l.rule_snapshot, l.group_id,
       'month:' || to_char(p.month, 'YYYY-MM'), p.month, (p.month + interval '1 month' - interval '1 day')::date,
       (p.month + interval '1 month' - interval '1 day')::date,
       coalesce(g.name, 'Forfait mensuel') || ', ' || to_char(p.month, 'MM/YYYY'),
       l.base, l.rate_numerator, l.rate_denominator, l.amount, l.details, 'validated',
       coalesce(p.calculated_at, p.created_at), coalesce(p.validated_at, now()), p.validated_by
from pay_lines l
join pay_periods p on p.id = l.period_id
left join groups g on g.id = l.group_id
where p.status in ('validated', 'paid');

insert into pay_item_sessions (item_id, session_id, instructor_id)
select i.id, cs.id, i.instructor_id
from pay_items i
join centres c on c.id = i.centre_id
join class_sessions cs on cs.group_id = i.group_id and cs.instructor_id = i.instructor_id
where i.group_id is not null
  and cs.status = 'held' and cs.sheet_status = 'validated'
  and (cs.starts_at at time zone c.timezone)::date between i.period_start and i.period_end;

insert into pay_items (id, centre_id, instructor_id, kind, period_key, period_start, period_end, due_on, label, amount, reason,
                       status, calculated_at, calculated_by, validated_at, validated_by)
select a.id, p.centre_id, a.instructor_id, a.kind, 'adjustment:' || a.id, p.month, (p.month + interval '1 month' - interval '1 day')::date,
       p.month, case when a.kind = 'bonus' then 'Prime : ' else 'Retenue : ' end || a.reason,
       case when a.kind = 'bonus' then a.amount else -a.amount end, a.reason,
       'validated', a.created_at, a.created_by, coalesce(p.validated_at, now()), p.validated_by
from pay_adjustments a
join pay_periods p on p.id = a.period_id
where p.status in ('validated', 'paid');

insert into pay_settlements (id, centre_id, instructor_id, number, paid_on, method, reference, amount, pdf, sha256, created_by, created_at)
select s.id, p.centre_id, s.instructor_id, 'PAIE-' || to_char(p.month, 'YYYY-MM') || '-' || substr(s.id::text, 1, 8),
       s.paid_on, s.payment_method, s.payment_reference, s.total, s.pdf, s.sha256, s.paid_by, s.issued_at
from payslips s
join pay_periods p on p.id = s.period_id
where s.paid_on is not null and s.total > 0;

insert into pay_settlement_lines (settlement_id, item_id, amount)
select s.id, i.id, i.amount
from payslips s
join pay_periods p on p.id = s.period_id
join pay_items i on i.instructor_id = s.instructor_id and i.status = 'validated'
  and i.period_start = p.month and (i.kind <> 'rule' or i.period_key = 'month:' || to_char(p.month, 'YYYY-MM'))
where s.paid_on is not null and s.total > 0 and i.amount <> 0;

drop table payslips;
drop table pay_adjustments;
drop table pay_lines;
drop table pay_periods;
