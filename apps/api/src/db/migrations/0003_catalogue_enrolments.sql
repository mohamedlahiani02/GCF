-- Catalogue (subjects, instructors, rooms, private studies, trainings), groups with weekly slots,
-- enrolments with their payment schedule, and the append-only financial event journal.

create extension if not exists btree_gist;

alter table centres
  add column count_justified_as_present boolean not null default false,
  add column count_makeup_as_present boolean not null default true,
  add column postponement_requires_approval boolean not null default true,
  add column max_postponements smallint not null default 2 check (max_postponements >= 0),
  add column overdue_grace_days smallint not null default 0 check (overdue_grace_days >= 0);

create table subjects (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  name text not null check (length(btrim(name)) > 0),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now()
);
create unique index subjects_name_key on subjects (centre_id, lower(name));

create table instructors (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  first_name text not null check (length(btrim(first_name)) > 0),
  last_name text not null check (length(btrim(last_name)) > 0),
  kind text not null check (kind in ('teacher', 'trainer')),
  employment text not null check (employment in ('salaried', 'freelance', 'contractor')),
  phone text,
  email text,
  notes text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index instructors_centre_idx on instructors (centre_id, status);

create table instructor_subjects (
  instructor_id uuid not null references instructors (id),
  subject_id uuid not null references subjects (id),
  primary key (instructor_id, subject_id)
);

create table instructor_availability (
  id uuid primary key default gen_random_uuid(),
  instructor_id uuid not null references instructors (id),
  weekday smallint not null check (weekday between 1 and 7),
  start_time time not null,
  end_time time not null,
  check (end_time > start_time)
);

create table rooms (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  name text not null check (length(btrim(name)) > 0),
  capacity integer not null check (capacity > 0),
  equipment text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now()
);
create unique index rooms_name_key on rooms (centre_id, lower(name));

create table studies (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  subject_id uuid not null references subjects (id),
  name text not null check (length(btrim(name)) > 0),
  billing_mode text not null check (billing_mode in ('monthly', 'per_session')),
  price bigint not null check (price >= 0),
  absence_billed boolean not null default true,
  sessions_per_week smallint not null check (sessions_per_week between 1 and 14),
  capacity integer not null check (capacity > 0),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index studies_name_key on studies (centre_id, lower(name));

create table trainings (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  title text not null check (length(btrim(title)) > 0),
  category text,
  description text,
  duration_hours integer not null check (duration_hours > 0),
  price bigint not null check (price >= 0),
  capacity integer not null check (capacity > 0),
  payment_modes text not null check (payment_modes in ('full', 'installments', 'both')),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index trainings_title_key on trainings (centre_id, lower(title));

create table payment_plans (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  training_id uuid not null references trainings (id),
  name text not null check (length(btrim(name)) > 0),
  is_default boolean not null default false,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now()
);
create unique index payment_plans_default_key on payment_plans (training_id) where is_default and status = 'active';

create table payment_plan_items (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references payment_plans (id),
  position smallint not null check (position >= 1),
  label text not null check (length(btrim(label)) > 0),
  value_kind text not null check (value_kind in ('percent', 'amount')),
  -- basis points for a percentage (4000 = 40 %), millimes for an amount
  value bigint not null check (value > 0),
  due_kind text not null check (due_kind in ('relative', 'fixed')),
  due_offset_days integer check (due_offset_days >= 0),
  due_date date,
  unique (plan_id, position),
  check ((due_kind = 'relative' and due_offset_days is not null and due_date is null)
      or (due_kind = 'fixed' and due_date is not null and due_offset_days is null))
);

create table training_sessions (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  training_id uuid not null references trainings (id),
  name text not null check (length(btrim(name)) > 0),
  start_date date not null,
  end_date date not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);

create table groups (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  kind text not null check (kind in ('study', 'training')),
  study_id uuid references studies (id),
  training_session_id uuid references training_sessions (id),
  name text not null check (length(btrim(name)) > 0),
  instructor_id uuid not null references instructors (id),
  room_id uuid references rooms (id),
  capacity integer not null check (capacity > 0),
  start_date date not null,
  end_date date not null,
  price_override bigint check (price_override >= 0),
  absence_billed_override boolean,
  count_justified_override boolean,
  count_makeup_override boolean,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date),
  check ((kind = 'study' and study_id is not null and training_session_id is null)
      or (kind = 'training' and training_session_id is not null and study_id is null))
);
create index groups_study_idx on groups (study_id);
create index groups_training_session_idx on groups (training_session_id);

create table group_slots (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups (id),
  weekday smallint not null check (weekday between 1 and 7),
  start_time time not null,
  end_time time not null,
  room_id uuid references rooms (id),
  check (end_time > start_time)
);
create index group_slots_group_idx on group_slots (group_id);

create table enrolments (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  student_id uuid not null references students (id),
  group_id uuid not null references groups (id),
  effective_date date not null,
  end_date date,
  status text not null default 'active' check (status in ('active', 'transferred', 'dropped', 'completed')),
  payment_mode text not null check (payment_mode in ('full', 'installments', 'monthly', 'per_session')),
  plan_id uuid references payment_plans (id),
  transferred_from_id uuid references enrolments (id),
  ended_reason text,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  check (end_date is null or end_date >= effective_date - 1),
  check ((payment_mode = 'installments') = (plan_id is not null))
);
create unique index enrolments_active_key on enrolments (student_id, group_id) where status = 'active';
create index enrolments_group_idx on enrolments (group_id, status);
create index enrolments_student_idx on enrolments (student_id);

create table installments (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  enrolment_id uuid not null references enrolments (id),
  label text not null check (length(btrim(label)) > 0),
  kind text not null check (kind in ('charge', 'discount')),
  amount bigint not null,
  due_date date not null,
  original_due_date date not null,
  postponement_count smallint not null default 0 check (postponement_count >= 0),
  discount_status text check (discount_status in ('pending', 'approved', 'rejected')),
  status text not null default 'open' check (status in ('open', 'cancelled')),
  cancelled_at timestamptz,
  cancelled_by uuid references users (id),
  cancel_reason text,
  carried_from_id uuid references installments (id),
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  check ((kind = 'charge' and amount > 0 and discount_status is null)
      or (kind = 'discount' and amount < 0 and discount_status is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null and cancel_reason is not null))
);
create index installments_enrolment_idx on installments (enrolment_id);
create index installments_open_due_idx on installments (centre_id, due_date) where status = 'open';

-- Facts every future legal accounting entry is derived from. Never updated, never deleted.
create table financial_events (
  id bigint generated always as identity primary key,
  centre_id uuid not null references centres (id),
  at timestamptz not null default now(),
  event_type text not null,
  amount bigint not null,
  user_id uuid references users (id),
  student_id uuid references students (id),
  enrolment_id uuid references enrolments (id),
  group_id uuid references groups (id),
  study_id uuid references studies (id),
  training_id uuid references trainings (id),
  instructor_id uuid references instructors (id),
  room_id uuid references rooms (id),
  installment_id uuid references installments (id),
  payload jsonb
);
create index financial_events_centre_at_idx on financial_events (centre_id, at);
create index financial_events_type_idx on financial_events (centre_id, event_type);

create function financial_events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'financial_events is append-only (% not allowed)', tg_op using errcode = 'restrict_violation';
end;
$$;
create trigger financial_events_no_update_delete before update or delete on financial_events
  for each row execute function financial_events_append_only();
create trigger financial_events_no_truncate before truncate on financial_events
  for each statement execute function financial_events_append_only();
