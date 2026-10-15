import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/types.js";

/**
 * Financial facts recorded at the moment they happen. Legal accounting entries (chart of accounts,
 * debit and credit lines) will be derived from these events in the accounting phase without changing
 * the operational tables.
 */
export type FinancialEventType =
  | "installment_issued"
  | "installment_cancelled"
  | "discount_granted"
  | "payment_received"
  | "payment_cancelled"
  | "cheque_bounced"
  | "payroll_validated"
  | "payroll_paid"
  | "cash_closed";

export interface FinancialEvent {
  centreId: string;
  type: FinancialEventType;
  amount: number;
  userId: string | null;
  studentId?: string | null;
  enrolmentId?: string | null;
  groupId?: string | null;
  studyId?: string | null;
  trainingId?: string | null;
  instructorId?: string | null;
  roomId?: string | null;
  installmentId?: string | null;
  payload?: Record<string, unknown>;
}

export async function recordFinancialEvents(db: Kysely<Database> | Transaction<Database>, events: FinancialEvent[]): Promise<void> {
  if (events.length === 0) return;
  await db
    .insertInto("financial_events")
    .values(
      events.map((e) => ({
        centre_id: e.centreId,
        event_type: e.type,
        amount: e.amount,
        user_id: e.userId,
        student_id: e.studentId ?? null,
        enrolment_id: e.enrolmentId ?? null,
        group_id: e.groupId ?? null,
        study_id: e.studyId ?? null,
        training_id: e.trainingId ?? null,
        instructor_id: e.instructorId ?? null,
        room_id: e.roomId ?? null,
        installment_id: e.installmentId ?? null,
        payload: e.payload ? JSON.stringify(e.payload) : null,
      })),
    )
    .execute();
}
