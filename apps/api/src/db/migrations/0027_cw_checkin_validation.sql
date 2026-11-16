-- Arrival by QR code on each place is an option the vendor enables per centre, like a module.
alter table centres
  drop constraint centres_modules_known,
  add constraint centres_modules_known check (modules <@ array['training', 'coworking', 'website', 'cafe', 'checkin']::text[]);

-- A booking confirmed by the staff counts as firm on the plan even before it is paid.
alter table cw_bookings
  add column validated_at timestamptz,
  add column validated_by uuid references users (id);

-- The secret printed in the QR code stuck on a place; the client scans it to record their arrival.
alter table cw_resources
  add column checkin_token text unique;

-- How long before its end a running booking shows its place as soon free; null hides that state.
alter table cw_settings
  add column ending_soon_minutes integer default 30 check (ending_soon_minutes between 5 and 240);
