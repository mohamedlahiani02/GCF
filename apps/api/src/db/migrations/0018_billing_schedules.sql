-- Shared formulas for courses and trainings. Existing enrollments and installment dates are untouched.
alter table payment_plans alter column training_id drop not null;
alter table payment_plans add column study_id uuid references studies(id);
alter table payment_plans add constraint payment_plans_one_owner check ((training_id is null) <> (study_id is null));
create unique index payment_plans_study_default_key on payment_plans(study_id) where is_default and status = 'active';
alter table payment_plans drop constraint payment_plans_tariff_rule;
alter table payment_plans add constraint payment_plans_tariff_rule check (kind not in ('monthly','per_session') or amount is not null);
alter table payment_plans
  add column monthly_due_kind text not null default 'anniversary' check (monthly_due_kind in ('anniversary','month_start','month_end','day_of_month')),
  add column monthly_due_day integer,
  add column due_offset_days integer not null default 0 check (due_offset_days between 0 and 365),
  add constraint payment_plans_due_day check ((monthly_due_kind = 'day_of_month' and monthly_due_day is not null and monthly_due_day between 1 and 31) or (monthly_due_kind <> 'day_of_month' and monthly_due_day is null));
-- Copy the agreed timing to each new enrollment; later formula changes cannot reprice or reschedule it.
alter table enrolments
  add column monthly_due_kind text not null default 'anniversary' check (monthly_due_kind in ('anniversary','month_start','month_end','day_of_month')),
  add column monthly_due_day integer,
  add column due_offset_days integer not null default 0 check (due_offset_days between 0 and 365),
  add constraint enrolments_due_day check ((monthly_due_kind = 'day_of_month' and monthly_due_day is not null and monthly_due_day between 1 and 31) or (monthly_due_kind <> 'day_of_month' and monthly_due_day is null));
