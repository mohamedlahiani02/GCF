-- Opening balances: what a student or a coworking member already owed when the centre moved to the application.
-- An opening debt is a charge without an enrolment or a service behind it. It is paid, postponed and reminded
-- like any charge, but it is not new revenue: the "invoiced" figures of the reports and the payroll bases
-- (which read enrolments) leave it out.
alter table installments
  add column opening_balance boolean not null default false,
  add column student_id uuid references students (id);

alter table installments drop constraint installments_one_owner;
alter table installments add constraint installments_one_owner check (
  (not opening_balance and student_id is null and num_nonnulls(enrolment_id, rental_id, member_id) = 1)
  or (opening_balance and enrolment_id is null and rental_id is null and num_nonnulls(student_id, member_id) = 1)
);

alter table installments drop constraint installments_member_source;
alter table installments add constraint installments_member_source check (
  (opening_balance and num_nonnulls(cw_booking_id, cw_subscription_id, cw_pack_id) = 0)
  or (
    not opening_balance
    and (
      (member_id is null and num_nonnulls(cw_booking_id, cw_subscription_id, cw_pack_id) = 0)
      or (member_id is not null and num_nonnulls(cw_booking_id, cw_subscription_id, cw_pack_id) = 1)
    )
  )
);

alter table installments add constraint installments_opening_is_charge check (not opening_balance or kind = 'charge');
create index installments_student_idx on installments (student_id) where student_id is not null;
