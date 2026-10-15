-- Dated sessions, room occupancy shared with rentals, attendance sheets and per-session charges.

create table class_sessions (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  group_id uuid not null references groups (id),
  instructor_id uuid not null references instructors (id),
  room_id uuid references rooms (id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'held', 'cancelled')),
  cancel_reason text,
  sheet_status text not null default 'none' check (sheet_status in ('none', 'in_progress', 'validated')),
  validated_at timestamptz,
  validated_by uuid references users (id),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check ((status = 'cancelled') = (cancel_reason is not null)),
  check ((sheet_status = 'validated') = (validated_at is not null)),
  -- An instructor and a group cannot be in two places at once.
  exclude using gist (instructor_id with =, tstzrange(starts_at, ends_at) with &&) where (status <> 'cancelled'),
  exclude using gist (group_id with =, tstzrange(starts_at, ends_at) with &&) where (status <> 'cancelled')
);
create unique index class_sessions_group_start_key on class_sessions (group_id, starts_at) where status <> 'cancelled';
create index class_sessions_centre_start_idx on class_sessions (centre_id, starts_at);

-- One row per occupied room interval, written by sessions and by rentals, so a room can never be double-booked.
create table room_bookings (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  room_id uuid not null references rooms (id),
  period tstzrange not null,
  session_id uuid references class_sessions (id),
  active boolean not null default true,
  exclude using gist (room_id with =, period with &&) where (active)
);
create unique index room_bookings_session_key on room_bookings (session_id) where active;

create table attendance_records (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  session_id uuid not null references class_sessions (id),
  student_id uuid not null references students (id),
  enrolment_id uuid not null references enrolments (id),
  status text not null check (status in ('present', 'absent', 'absent_justified', 'present_other_group')),
  is_guest boolean not null default false,
  host_session_id uuid references class_sessions (id),
  note text,
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id),
  unique (session_id, student_id),
  check ((status = 'present_other_group') = (host_session_id is not null)),
  check (not is_guest or status = 'present')
);
create index attendance_records_enrolment_idx on attendance_records (enrolment_id);

alter table installments add column session_id uuid references class_sessions (id);
create unique index installments_session_charge_key on installments (enrolment_id, session_id) where session_id is not null and status = 'open';
