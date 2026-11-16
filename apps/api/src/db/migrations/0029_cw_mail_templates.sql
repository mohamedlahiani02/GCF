-- The centre's own wording of the e-mails sent about bookings. A missing row means the default wording.
create table cw_mail_templates (
  centre_id uuid not null references centres (id),
  key text not null check (key in ('booking_confirmed', 'booking_refused', 'booking_cancelled', 'booking_reminder')),
  subject text not null check (length(btrim(subject)) between 1 and 200),
  body text not null check (length(btrim(body)) between 1 and 5000),
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id),
  primary key (centre_id, key)
);

-- How long before its start a confirmed booking gets a reminder e-mail; null sends none.
alter table cw_settings
  add column reminder_hours integer default 24 check (reminder_hours between 1 and 168);

-- Set when the reminder is claimed, so each booking gets at most one even with several server processes.
alter table cw_bookings
  add column reminder_sent_at timestamptz;
