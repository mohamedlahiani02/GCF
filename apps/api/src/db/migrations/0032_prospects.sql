-- Prospects: people or companies interested in the centre, followed from first contact to signing up. A website
-- request can become a prospect; a won prospect becomes a coworking client or a student, and keeps the link.
create table prospect_tags (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  name text not null check (length(btrim(name)) between 1 and 40),
  color text not null default '#5b6478' check (color ~ '^#[0-9a-f]{6}$'),
  created_at timestamptz not null default now()
);
create unique index prospect_tags_name_key on prospect_tags (centre_id, lower(name));

create table prospects (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references centres (id),
  name text not null check (length(btrim(name)) between 1 and 120),
  company text check (length(company) <= 120),
  email text check (email = lower(email)),
  phone text check (length(phone) <= 40),
  interests text[] not null default '{}' check (interests <@ array['training', 'coworking', 'rental', 'cafe', 'other']::text[]),
  source text not null check (source in ('website', 'walk_in', 'phone', 'referral', 'event', 'social', 'other')),
  stage text not null default 'new' check (stage in ('new', 'contacted', 'visit', 'proposal', 'won', 'lost')),
  lost_reason text check (length(lost_reason) <= 300),
  owner_id uuid references users (id),
  next_action text check (length(next_action) <= 200),
  next_action_on date,
  notes text check (length(notes) <= 2000),
  site_lead_id uuid unique references site_leads (id),
  member_id uuid references members (id),
  student_id uuid references students (id),
  won_at timestamptz,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email is not null or phone is not null),
  check ((stage = 'lost') = (lost_reason is not null)),
  check ((stage = 'won') = (won_at is not null)),
  check (num_nonnulls(member_id, student_id) <= 1)
);
create index prospects_centre_stage_idx on prospects (centre_id, stage);
create index prospects_next_action_idx on prospects (centre_id, next_action_on) where stage not in ('won', 'lost');

create table prospect_tag_links (
  prospect_id uuid not null references prospects (id) on delete cascade,
  tag_id uuid not null references prospect_tags (id) on delete cascade,
  primary key (prospect_id, tag_id)
);

-- What happened with a prospect: notes, calls, e-mails, visits and every change of stage.
create table prospect_activities (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects (id) on delete cascade,
  kind text not null check (kind in ('note', 'call', 'email', 'visit', 'stage')),
  text text not null check (length(btrim(text)) between 1 and 2000),
  at timestamptz not null default now(),
  user_id uuid references users (id)
);
create index prospect_activities_prospect_idx on prospect_activities (prospect_id, at desc);
