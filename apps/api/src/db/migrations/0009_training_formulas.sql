-- A training is sold through one or more formulas ("formules"), like private lessons: paid in full, in instalments,
-- monthly or per session. The former payment_modes column becomes formulas, and existing instalment plans keep
-- their items as formulas of kind 'installments'.

alter table payment_plans
  add column kind text not null default 'installments' check (kind in ('full', 'installments', 'monthly', 'per_session')),
  -- Monthly or per-session tariff; for a full payment, an optional price replacing the training price.
  add column amount bigint check (amount >= 0),
  -- Per-session formulas only: whether an absence is still billed.
  add column absence_billed boolean,
  add constraint payment_plans_tariff_rule check (
    (kind in ('monthly', 'per_session') and amount is not null)
    or (kind = 'full')
    or (kind = 'installments' and amount is null)
  ),
  add constraint payment_plans_absence_rule check ((kind = 'per_session') = (absence_billed is not null));

-- Every training that could be paid in full gets an explicit "full payment" formula.
insert into payment_plans (centre_id, training_id, name, kind, is_default)
select t.centre_id, t.id, 'Paiement intégral', 'full',
       not exists (select 1 from payment_plans p where p.training_id = t.id and p.is_default and p.status = 'active')
from trainings t
where t.payment_modes in ('full', 'both');

alter table trainings drop column payment_modes;

-- An enrolment in a training always names its formula. The tariff of a per-session formula is copied at enrolment
-- so a later change of the formula never reprices sessions of students already enrolled.
alter table enrolments drop constraint enrolments_check1;
alter table enrolments
  add column session_price bigint check (session_price >= 0),
  add column session_absence_billed boolean,
  add constraint enrolments_installments_plan check (payment_mode <> 'installments' or plan_id is not null),
  add constraint enrolments_session_terms check ((session_price is null) = (session_absence_billed is null));
