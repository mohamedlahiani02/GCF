-- Rules that were fixed in code become settings, each defaulting to the previous behaviour.

-- A guardian for a minor student is now optional unless the centre requires one. The application enforces the
-- setting, so the table constraint that made it mandatory everywhere is removed.
alter table centres add column guardian_required_for_minors boolean not null default false;
alter table students drop constraint students_minor_has_guardian;

-- Per pay rule: whether a cancelled session is paid, and whether a held session with no student present is paid.
-- Both only make sense for a base counted per session or per hour; any other base keeps the defaults.
alter table pay_rules add column pay_cancelled_sessions boolean not null default false;
alter table pay_rules add column pay_empty_sessions boolean not null default true;
alter table pay_rules add constraint pay_rules_session_options_fit_base check (
  base_kind in ('fixed_per_session', 'pct_session_tariff', 'hourly')
  or (not pay_cancelled_sessions and pay_empty_sessions)
);
