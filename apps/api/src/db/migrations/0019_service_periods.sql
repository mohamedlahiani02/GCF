-- Due date is a collection deadline, not the service period. Legacy rows retain their original behavior.
alter table installments
  add column service_period_start date,
  add column service_period_end date,
  add constraint installments_service_period check (
    (service_period_start is null and service_period_end is null)
    or (service_period_start is not null and service_period_end is not null and service_period_end >= service_period_start)
  );
