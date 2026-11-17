-- Invoices and credit notes become an option the vendor enables per centre, off by default. Existing invoices
-- and counters are kept untouched: switching the option back on shows them again.
alter table centres
  drop constraint centres_modules_known,
  add constraint centres_modules_known check (modules <@ array['training', 'coworking', 'website', 'cafe', 'checkin', 'invoicing']::text[]);
