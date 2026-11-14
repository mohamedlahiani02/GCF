import { sql } from "kysely";
import { z } from "zod";

export const financialActivity = z.enum(["training", "study", "coworking", "rental"]);
export type FinancialActivity = z.infer<typeof financialActivity>;

/** An instalment has one origin, independently of the person who owes it. */
export const installmentActivity = sql<FinancialActivity>`case
  when installments.rental_id is not null then 'rental'
  when installments.member_id is not null then 'coworking'
  else (
    select groups.kind from enrolments
    inner join groups on groups.id = enrolments.group_id
    where enrolments.id = installments.enrolment_id
      and enrolments.centre_id = installments.centre_id
  )
end`;

/** A student's payment can cover both courses and training; an unallocated advance has no assigned activity. */
export const paymentActivities = sql<FinancialActivity[]>`case
  when payments.renter_id is not null then array['rental']::text[]
  when payments.member_id is not null then array['coworking']::text[]
  else coalesce((
    select array_agg(distinct groups.kind order by groups.kind)
    from allocations
    inner join installments on installments.id = allocations.installment_id
    inner join enrolments on enrolments.id = installments.enrolment_id
    inner join groups on groups.id = enrolments.group_id
    where allocations.payment_id = payments.id
      and allocations.centre_id = payments.centre_id
  ), array[]::text[])
end`;
