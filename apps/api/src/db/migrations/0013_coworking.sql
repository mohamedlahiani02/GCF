-- Coworking: floors and their interactive plan, bookable resources, booking formats and prices, rules,
-- closures, subscription plans, credit packs, promotion codes, bookings with check-in, domiciliation mail.

create table cw_settings (
  centre_id uuid primary key references centres (id),
  -- How far ahead and how late a portal booking may be made.
  booking_horizon_days integer not null default 30 check (booking_horizon_days between 1 and 365),
  min_notice_minutes integer not null default 0 check (min_notice_minutes between 0 and 10080),
  max_active_bookings integer not null default 5 check (max_active_bookings between 1 and 100),
  -- none: every portal booking is confirmed at once; visitors: only clients without an active subscription
  -- send a request; all: every portal booking is a request the staff validates or refuses.
  approval_mode text not null default 'visitors' check (approval_mode in ('none', 'visitors', 'all')),
  free_cancel_hours integer not null default 24 check (free_cancel_hours between 0 and 720),
  late_cancel_fee_bp integer not null default 0 check (late_cancel_fee_bp between 0 and 10000),
  -- A confirmed booking without check-in this many minutes after its start is released; null disables it.
  no_show_grace_minutes integer default 30 check (no_show_grace_minutes between 5 and 240),
  request_expiry_hours integer not null default 24 check (request_expiry_hours between 1 and 720),
  -- open: a new portal account is active at once; validated: it waits for the staff; closed: invitation only.
  self_signup text not null default 'validated' check (self_signup in ('open', 'validated', 'closed')),
  -- Bookings starting at or after this time use the off-peak price when the format has one.
  offpeak_from time,
  portal_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id)
);

create table cw_floors (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  name text not null check (length(btrim(name)) > 0),
  position integer not null default 0,
  plan_media_id uuid references media_files (id),
  -- Published layout (what the staff and the clients see) and the draft being edited, validated by the API.
  layout jsonb not null default '{"items": [], "labels": []}',
  draft_layout jsonb,
  layout_published_at timestamptz,
  layout_published_by uuid references users (id),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now()
);
create unique index cw_floors_name_key on cw_floors (centre_id, lower(name));

create table cw_zones (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  floor_id uuid not null references cw_floors (id),
  name text not null check (length(btrim(name)) > 0),
  color text not null default '#64748b' check (color ~ '^#[0-9a-f]{6}$'),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now()
);
create unique index cw_zones_name_key on cw_zones (floor_id, lower(name));

create table cw_attributes (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  name text not null check (length(btrim(name)) > 0),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now()
);
create unique index cw_attributes_name_key on cw_attributes (centre_id, lower(name));

-- Dedicated desks and private offices are assigned through a subscription; the other categories are booked.
create table cw_resource_types (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  name text not null check (length(btrim(name)) > 0),
  category text not null check (category in ('hot_desk', 'dedicated_desk', 'private_office', 'meeting_room', 'phone_booth', 'event_space')),
  description text,
  photo_media_id uuid references media_files (id),
  requires_approval boolean not null default false,
  max_minutes_per_day integer check (max_minutes_per_day between 15 and 1440),
  buffer_minutes integer not null default 0 check (buffer_minutes between 0 and 240),
  position integer not null default 0,
  public boolean not null default true,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index cw_resource_types_name_key on cw_resource_types (centre_id, lower(name));

create table cw_resources (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  type_id uuid not null references cw_resource_types (id),
  floor_id uuid not null references cw_floors (id),
  zone_id uuid references cw_zones (id),
  code text not null check (length(btrim(code)) between 1 and 20),
  name text,
  capacity integer not null default 1 check (capacity between 1 and 500),
  -- A meeting room shared with the training centre books the same room, so it is never used twice.
  room_id uuid references rooms (id),
  status text not null default 'active' check (status in ('active', 'out_of_service', 'archived')),
  out_of_service_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'out_of_service') = (out_of_service_reason is not null))
);
create unique index cw_resources_code_key on cw_resources (centre_id, lower(code));
create unique index cw_resources_room_key on cw_resources (room_id) where room_id is not null and status <> 'archived';
create index cw_resources_floor_idx on cw_resources (floor_id);

create table cw_resource_attributes (
  resource_id uuid not null references cw_resources (id) on delete cascade,
  attribute_id uuid not null references cw_attributes (id),
  primary key (resource_id, attribute_id)
);

-- fixed: a duration starting every step (1 h, 2 h); named: fixed hours (morning, full day);
-- free: any duration between a minimum and a maximum, priced per hour.
create table cw_booking_formats (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  type_id uuid not null references cw_resource_types (id),
  label text not null check (length(btrim(label)) > 0),
  nature text not null check (nature in ('fixed', 'named', 'free')),
  duration_minutes integer,
  start_step_minutes integer,
  start_time time,
  end_time time,
  min_minutes integer,
  max_minutes integer,
  weekdays smallint[] not null default '{1,2,3,4,5,6,7}',
  position integer not null default 0,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  check (weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[] and cardinality(weekdays) between 1 and 7),
  check (
    (nature = 'fixed' and duration_minutes between 15 and 1440 and start_step_minutes in (15, 30, 60)
      and start_time is null and end_time is null and min_minutes is null and max_minutes is null)
    or (nature = 'named' and start_time is not null and end_time is not null and end_time > start_time
      and duration_minutes is null and start_step_minutes is null and min_minutes is null and max_minutes is null)
    or (nature = 'free' and min_minutes between 15 and 1440 and max_minutes between min_minutes and 1440 and start_step_minutes in (15, 30, 60)
      and duration_minutes is null and start_time is null and end_time is null)
  )
);
create unique index cw_booking_formats_label_key on cw_booking_formats (type_id, lower(label)) where status = 'active';

-- visitor: a client without an active subscription; member: a client with one. A free format is priced per hour.
create table cw_prices (
  format_id uuid not null references cw_booking_formats (id),
  profile text not null check (profile in ('visitor', 'member')),
  amount bigint not null check (amount >= 0),
  offpeak_amount bigint check (offpeak_amount >= 0),
  primary key (format_id, profile)
);

-- Whole days closed (both times null) or reduced opening hours on those days.
create table cw_closures (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  starts_on date not null,
  ends_on date not null,
  label text not null check (length(btrim(label)) > 0),
  open_from time,
  open_to time,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on),
  check ((open_from is null and open_to is null) or (open_from is not null and open_to is not null and open_to > open_from))
);
create index cw_closures_centre_idx on cw_closures (centre_id, starts_on);

create table cw_plans (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  name text not null check (length(btrim(name)) > 0),
  description text,
  period text not null check (period in ('month', 'quarter', 'year')),
  price bigint not null check (price > 0),
  billing text not null check (billing in ('upfront', 'monthly')),
  includes_domiciliation boolean not null default false,
  -- Plans of dedicated desks and private offices assign one resource of this type to the subscriber.
  assigned_type_id uuid references cw_resource_types (id),
  notice_days integer not null default 0 check (notice_days between 0 and 365),
  public boolean not null default true,
  position integer not null default 0,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (billing = 'upfront' or period in ('quarter', 'year'))
);
create unique index cw_plans_name_key on cw_plans (centre_id, lower(name));

-- Quotas restart every month of the subscription, counted from its start date.
create table cw_plan_entitlements (
  plan_id uuid not null references cw_plans (id) on delete cascade,
  type_id uuid not null references cw_resource_types (id),
  quota_kind text not null check (quota_kind in ('unlimited', 'minutes', 'bookings')),
  quota integer check (quota > 0),
  primary key (plan_id, type_id),
  check ((quota_kind = 'unlimited') = (quota is null))
);

create table cw_pack_products (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  name text not null check (length(btrim(name)) > 0),
  type_id uuid not null references cw_resource_types (id),
  quota_kind text not null check (quota_kind in ('minutes', 'bookings')),
  quota integer not null check (quota > 0),
  validity_days integer not null check (validity_days between 1 and 1095),
  price bigint not null check (price > 0),
  public boolean not null default true,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now()
);
create unique index cw_pack_products_name_key on cw_pack_products (centre_id, lower(name));

create table cw_promo_codes (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  code text not null check (code ~ '^[A-Z0-9-]{3,30}$'),
  kind text not null check (kind in ('percent', 'amount')),
  value bigint not null check (value > 0),
  valid_from date not null,
  valid_to date not null,
  max_uses integer check (max_uses > 0),
  profiles text[] not null default '{visitor,member}',
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  check (valid_to >= valid_from),
  check (kind = 'amount' or value <= 10000),
  check (profiles <@ array['visitor', 'member']::text[] and cardinality(profiles) >= 1)
);
create unique index cw_promo_codes_code_key on cw_promo_codes (centre_id, code);

create table cw_subscriptions (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  member_id uuid not null references members (id),
  plan_id uuid not null references cw_plans (id),
  starts_on date not null,
  ends_on date not null,
  price bigint not null check (price > 0),
  billing text not null check (billing in ('upfront', 'monthly')),
  includes_domiciliation boolean not null,
  -- The plan's quotas when the subscription was sold: later plan changes never alter what was bought.
  entitlements jsonb not null default '[]',
  assigned_resource_id uuid references cw_resources (id),
  auto_renew boolean not null default false,
  renewed_from_id uuid references cw_subscriptions (id),
  status text not null default 'active' check (status in ('active', 'cancelled')),
  cancelled_at timestamptz,
  cancelled_by uuid references users (id),
  cancel_reason text,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on),
  check ((status = 'cancelled') = (cancelled_at is not null and cancel_reason is not null)),
  exclude using gist (assigned_resource_id with =, daterange(starts_on, ends_on, '[]') with &&)
    where (status = 'active' and assigned_resource_id is not null)
);
create index cw_subscriptions_member_idx on cw_subscriptions (member_id, starts_on);
create unique index cw_subscriptions_renewal_key on cw_subscriptions (renewed_from_id) where renewed_from_id is not null and status = 'active';

create table cw_packs (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  member_id uuid not null references members (id),
  product_id uuid not null references cw_pack_products (id),
  type_id uuid not null references cw_resource_types (id),
  quota_kind text not null check (quota_kind in ('minutes', 'bookings')),
  quota integer not null check (quota > 0),
  price bigint not null check (price > 0),
  starts_on date not null,
  expires_on date not null,
  status text not null default 'active' check (status in ('active', 'cancelled')),
  cancelled_at timestamptz,
  cancelled_by uuid references users (id),
  cancel_reason text,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  check (expires_on >= starts_on),
  check ((status = 'cancelled') = (cancelled_at is not null and cancel_reason is not null))
);
create index cw_packs_member_idx on cw_packs (member_id, expires_on);

-- A booking occupies [starts_at, blocked_until): blocked_until adds the cleaning buffer of the resource type.
-- A block is an occupation without a client (maintenance, private event).
create table cw_bookings (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  kind text not null default 'booking' check (kind in ('booking', 'block')),
  resource_id uuid not null references cw_resources (id),
  member_id uuid references members (id),
  format_id uuid references cw_booking_formats (id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  blocked_until timestamptz not null,
  status text not null check (status in ('requested', 'confirmed', 'checked_in', 'completed', 'cancelled', 'refused', 'expired', 'no_show')),
  source text not null check (source in ('portal', 'staff')),
  profile text check (profile in ('visitor', 'member')),
  list_price bigint not null default 0 check (list_price >= 0),
  promo_code_id uuid references cw_promo_codes (id),
  promo_discount bigint not null default 0 check (promo_discount >= 0),
  covered_minutes integer not null default 0 check (covered_minutes >= 0),
  coverage_discount bigint not null default 0 check (coverage_discount >= 0),
  charge bigint not null default 0 check (charge >= 0),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references users (id),
  refusal_reason text,
  cancelled_at timestamptz,
  cancelled_by uuid references users (id),
  cancel_reason text,
  late_cancel_fee bigint not null default 0 check (late_cancel_fee >= 0),
  checked_in_at timestamptz,
  check_in_code text not null unique default replace(gen_random_uuid()::text, '-', ''),
  notes text,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (blocked_until >= ends_at),
  check ((kind = 'block') = (member_id is null)),
  check (kind = 'booking' or (format_id is null and profile is null and charge = 0 and list_price = 0)),
  check (kind = 'block' or profile is not null),
  check (charge = list_price - promo_discount - coverage_discount),
  check ((status = 'refused') = (refusal_reason is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null and cancel_reason is not null)),
  check (status <> 'checked_in' or checked_in_at is not null),
  exclude using gist (resource_id with =, tstzrange(starts_at, blocked_until) with &&)
    where (status in ('requested', 'confirmed', 'checked_in'))
);
create index cw_bookings_centre_start_idx on cw_bookings (centre_id, starts_at);
create index cw_bookings_member_idx on cw_bookings (member_id, starts_at desc);
create index cw_bookings_requested_idx on cw_bookings (centre_id, requested_at) where status = 'requested';

-- What a booking took from a subscription quota or a credit pack; released when the booking is cancelled in time
-- or refused. window_start is the first day of the subscription month the booking falls in.
create table cw_entitlement_usage (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  booking_id uuid not null references cw_bookings (id),
  subscription_id uuid references cw_subscriptions (id),
  pack_id uuid references cw_packs (id),
  quota_kind text not null check (quota_kind in ('unlimited', 'minutes', 'bookings')),
  amount integer not null check (amount >= 0),
  window_start date,
  status text not null default 'active' check (status in ('active', 'released')),
  created_at timestamptz not null default now(),
  check (num_nonnulls(subscription_id, pack_id) = 1),
  check ((subscription_id is not null) = (window_start is not null))
);
create index cw_entitlement_usage_booking_idx on cw_entitlement_usage (booking_id);
create index cw_entitlement_usage_subscription_idx on cw_entitlement_usage (subscription_id, window_start) where status = 'active';
create index cw_entitlement_usage_pack_idx on cw_entitlement_usage (pack_id) where status = 'active';

-- Every entry into the space. Today recorded by the staff or by scanning the booking QR code; a badge reader
-- or a connected lock would add its own source here without changing bookings.
create table cw_access_events (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  member_id uuid not null references members (id),
  booking_id uuid references cw_bookings (id),
  at timestamptz not null default now(),
  source text not null check (source in ('staff', 'qr')),
  recorded_by uuid references users (id)
);
create index cw_access_events_centre_at_idx on cw_access_events (centre_id, at desc);
create index cw_access_events_member_idx on cw_access_events (member_id, at desc);

-- Mail received for domiciled members.
create table cw_mail_items (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  member_id uuid not null references members (id),
  received_at timestamptz not null default now(),
  kind text not null check (kind in ('letter', 'registered', 'parcel', 'other')),
  sender text,
  reference text,
  status text not null default 'received' check (status in ('received', 'notified', 'collected', 'returned')),
  notified_at timestamptz,
  collected_at timestamptz,
  collected_by_name text,
  handed_by uuid references users (id),
  notes text,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  check ((status = 'collected') = (collected_at is not null and collected_by_name is not null))
);
create index cw_mail_items_member_idx on cw_mail_items (member_id, received_at desc);
create index cw_mail_items_open_idx on cw_mail_items (centre_id, received_at) where status in ('received', 'notified');

-- Coworking charges are instalments owned by the member and tied to a booking, a subscription or a pack.
alter table installments
  add column member_id uuid references members (id),
  add column cw_booking_id uuid references cw_bookings (id),
  add column cw_subscription_id uuid references cw_subscriptions (id),
  add column cw_pack_id uuid references cw_packs (id);
alter table installments drop constraint installments_one_owner;
alter table installments add constraint installments_one_owner check (num_nonnulls(enrolment_id, rental_id, member_id) = 1);
alter table installments add constraint installments_member_source
  check ((member_id is null and num_nonnulls(cw_booking_id, cw_subscription_id, cw_pack_id) = 0)
      or (member_id is not null and num_nonnulls(cw_booking_id, cw_subscription_id, cw_pack_id) = 1));
create index installments_member_idx on installments (member_id);
create index installments_cw_booking_idx on installments (cw_booking_id);
create index installments_cw_subscription_idx on installments (cw_subscription_id);

alter table room_bookings add column cw_booking_id uuid references cw_bookings (id);
alter table room_bookings drop constraint room_bookings_one_source;
alter table room_bookings add constraint room_bookings_one_source check (num_nonnulls(session_id, rental_slot_id, cw_booking_id) = 1);
create unique index room_bookings_cw_booking_key on room_bookings (cw_booking_id) where active;

alter table financial_events
  add column cw_booking_id uuid references cw_bookings (id),
  add column cw_subscription_id uuid references cw_subscriptions (id),
  add column cw_pack_id uuid references cw_packs (id);
