-- Existing enrolments keep the amounts and policy already agreed. New monthly enrolments opt in through the API.
alter table enrolments
  add column prorate_partial_months boolean not null default false,
  add constraint enrolments_proration_monthly check (not prorate_partial_months or payment_mode = 'monthly');
