-- Instructor pay: rules (instructor default, study or training, group), monthly periods, computed lines with
-- the rule copied in, manual adjustments, payslips and payment records.

create table pay_rules (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  instructor_id uuid not null references instructors (id),
  scope text not null check (scope in ('instructor', 'study', 'training', 'group')),
  study_id uuid references studies (id),
  training_id uuid references trainings (id),
  group_id uuid references groups (id),
  base_kind text not null check (base_kind in ('pct_collections', 'pct_session_tariff', 'fixed_per_session', 'monthly_flat', 'hourly', 'training_flat')),
  basis_points integer check (basis_points between 1 and 10000),
  amount bigint check (amount >= 0),
  collection_basis text check (collection_basis in ('collected', 'invoiced')),
  presence_kind text not null check (presence_kind in ('ignore', 'prorata', 'session_due', 'threshold')),
  min_rate_basis_points integer check (min_rate_basis_points between 1 and 10000),
  floor_amount bigint check (floor_amount >= 0),
  prorata_above boolean,
  valid_from date not null,
  valid_to date,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from),
  check ((scope = 'instructor' and study_id is null and training_id is null and group_id is null)
      or (scope = 'study' and study_id is not null and training_id is null and group_id is null)
      or (scope = 'training' and training_id is not null and study_id is null and group_id is null)
      or (scope = 'group' and group_id is not null and study_id is null and training_id is null)),
  check ((base_kind in ('pct_collections') and basis_points is not null and amount is null and collection_basis is not null)
      or (base_kind = 'pct_session_tariff' and basis_points is not null and amount is not null and collection_basis is null)
      or (base_kind in ('fixed_per_session', 'monthly_flat', 'hourly', 'training_flat') and basis_points is null and amount is not null and collection_basis is null)),
  check ((presence_kind = 'threshold') = (min_rate_basis_points is not null and prorata_above is not null)),
  check (presence_kind = 'threshold' or floor_amount is null)
);
create index pay_rules_instructor_idx on pay_rules (instructor_id, status);

create table pay_periods (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  month date not null check (extract(day from month) = 1),
  status text not null default 'draft' check (status in ('draft', 'calculated', 'validated', 'paid')),
  calculated_at timestamptz,
  validated_at timestamptz,
  validated_by uuid references users (id),
  created_at timestamptz not null default now(),
  unique (centre_id, month)
);

create table pay_lines (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references pay_periods (id),
  instructor_id uuid not null references instructors (id),
  group_id uuid references groups (id),
  rule_id uuid not null references pay_rules (id),
  rule_snapshot jsonb not null,
  base bigint not null,
  rate_numerator integer not null,
  rate_denominator integer not null,
  amount bigint not null,
  details jsonb not null
);
create index pay_lines_period_idx on pay_lines (period_id, instructor_id);

create table pay_adjustments (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references pay_periods (id),
  instructor_id uuid not null references instructors (id),
  kind text not null check (kind in ('bonus', 'deduction')),
  amount bigint not null check (amount > 0),
  reason text not null check (length(btrim(reason)) > 0),
  created_by uuid references users (id),
  created_at timestamptz not null default now()
);

create table payslips (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references pay_periods (id),
  instructor_id uuid not null references instructors (id),
  total bigint not null,
  pdf bytea not null,
  sha256 text not null,
  issued_at timestamptz not null default now(),
  paid_on date,
  payment_method text check (payment_method in ('cash', 'transfer', 'cheque')),
  payment_reference text,
  paid_by uuid references users (id),
  unique (period_id, instructor_id),
  check ((paid_on is null) = (payment_method is null))
);
