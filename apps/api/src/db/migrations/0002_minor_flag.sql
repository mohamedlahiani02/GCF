-- Minority is an explicit choice made by the secretariat, not derived from an age computation.
alter table centres drop column majority_age;
alter table students add column is_minor boolean not null default false;
alter table students add constraint students_minor_has_guardian check (
  not is_minor or (guardian_name is not null and (guardian_phone is not null or guardian_email is not null))
);
create index students_minor_idx on students (centre_id) where is_minor;
