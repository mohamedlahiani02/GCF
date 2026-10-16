import type { Transaction } from "kysely";
import type { Database } from "../../db/types.js";
import { cancelUnpaidCharge } from "../attendance.js";
import { recordFinancialEvents } from "../financialEvents.js";

export interface ChargeLine {
  label: string;
  amount: number;
  dueDate: string;
}

/** What a coworking charge pays for, besides bookings (written by the bookings module). */
export type ChargeSource = { cwSubscriptionId: string } | { cwPackId: string };

const sourceColumns = (source: ChargeSource) =>
  "cwSubscriptionId" in source ? { cw_subscription_id: source.cwSubscriptionId, cw_pack_id: null } : { cw_subscription_id: null, cw_pack_id: source.cwPackId };

/**
 * Creates the member's charges for a subscription or a pack and records them in the financial journal. The caller
 * locks the member before and settles the member after, so existing credit pays the new charges.
 */
export async function issueMemberCharges(
  trx: Transaction<Database>,
  centreId: string,
  memberId: string,
  source: ChargeSource,
  lines: ChargeLine[],
  userId: string | null,
): Promise<{ id: string; amount: number; dueDate: string }[]> {
  if (lines.length === 0) return [];
  const charges = await trx
    .insertInto("installments")
    .values(
      lines.map((l) => ({
        centre_id: centreId,
        enrolment_id: null,
        rental_id: null,
        member_id: memberId,
        cw_booking_id: null,
        ...sourceColumns(source),
        label: l.label,
        kind: "charge" as const,
        amount: l.amount,
        due_date: l.dueDate,
        original_due_date: l.dueDate,
        discount_status: null,
        created_by: userId,
      })),
    )
    .returning(["id", "amount", "due_date as dueDate"])
    .execute();
  await recordFinancialEvents(
    trx,
    charges.map((c) => ({ centreId, type: "installment_issued" as const, amount: c.amount, userId, installmentId: c.id, memberId, ...source })),
  );
  return charges;
}

/**
 * Cancels open charges of a subscription or a pack. A charge that already received money stops the whole operation
 * (409 installment_paid), so the caller's transaction is rolled back and nothing is half cancelled.
 */
export async function cancelMemberCharges(
  trx: Transaction<Database>,
  centreId: string,
  memberId: string,
  source: ChargeSource,
  charges: { id: string; amount: number }[],
  userId: string,
  reason: string,
): Promise<void> {
  for (const charge of charges) await cancelUnpaidCharge(trx, charge.id, userId, reason);
  await recordFinancialEvents(
    trx,
    charges.map((c) => ({ centreId, type: "installment_cancelled" as const, amount: -c.amount, userId, installmentId: c.id, memberId, ...source })),
  );
}
