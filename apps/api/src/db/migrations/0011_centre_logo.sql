-- The centre's logo, shown in the application's navigation. Stored with the centre (a few hundred kilobytes at most)
-- so it is backed up with the data and needs no file storage.
alter table centres
  add column logo bytea check (octet_length(logo) <= 524288),
  add column logo_mime text check (logo_mime in ('image/png', 'image/jpeg', 'image/webp')),
  add column logo_updated_at timestamptz,
  add constraint centres_logo_complete check (
    (logo is null and logo_mime is null and logo_updated_at is null)
    or (logo is not null and logo_mime is not null and logo_updated_at is not null)
  );
