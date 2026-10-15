import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, string | null | undefined, string | null>;

export type Role = "admin" | "secretariat" | "accountant";

export interface CentresTable {
  id: Generated<string>;
  name: string;
  address: string | null;
  tax_id: string | null;
  currency: Generated<string>;
  currency_decimals: Generated<number>;
  locale: Generated<"fr" | "ar">;
  timezone: Generated<string>;
  count_justified_as_present: Generated<boolean>;
  count_makeup_as_present: Generated<boolean>;
  postponement_requires_approval: Generated<boolean>;
  max_postponements: Generated<number>;
  overdue_grace_days: Generated<number>;
  receipt_prefix: Generated<string>;
  receipt_footer: string | null;
  open_from: Generated<string>;
  open_to: Generated<string>;
  open_weekdays: Generated<number[]>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface UsersTable {
  id: Generated<string>;
  centre_id: string;
  email: string;
  full_name: string;
  role: Role;
  password_hash: string;
  active: Generated<boolean>;
  failed_login_count: Generated<number>;
  locked_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  last_login_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  token_hash: Buffer;
  created_at: Timestamp;
  last_seen_at: Timestamp;
  absolute_expires_at: Date | string;
  user_agent: string | null;
}

export interface AuditLogTable {
  id: Generated<number>;
  centre_id: string;
  at: Timestamp;
  user_id: string | null;
  action: string;
  object_type: string;
  object_id: string;
  before: Json;
  after: Json;
  reason: string | null;
}

export interface StudentsTable {
  id: Generated<string>;
  centre_id: string;
  first_name: string;
  last_name: string;
  birth_date: ColumnType<string | null, string | null | undefined, string | null>;
  is_minor: Generated<boolean>;
  phone: string | null;
  email: string | null;
  receipt_email: string | null;
  guardian_name: string | null;
  guardian_phone: string | null;
  guardian_email: string | null;
  notes: string | null;
  status: Generated<"active" | "archived">;
  created_at: Timestamp;
  updated_at: Timestamp;
  created_by: string | null;
}

type DateColumn = ColumnType<string, string, string>;
type NullableDate = ColumnType<string | null, string | null | undefined, string | null>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Status = Generated<"active" | "archived">;

export interface SubjectsTable {
  id: Generated<string>;
  centre_id: string;
  name: string;
  status: Status;
  created_at: Timestamp;
}

export interface InstructorsTable {
  id: Generated<string>;
  centre_id: string;
  first_name: string;
  last_name: string;
  kind: "teacher" | "trainer";
  employment: "salaried" | "freelance" | "contractor";
  phone: string | null;
  email: string | null;
  notes: string | null;
  status: Status;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface InstructorSubjectsTable {
  instructor_id: string;
  subject_id: string;
}

export interface InstructorAvailabilityTable {
  id: Generated<string>;
  instructor_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
}

export interface RoomsTable {
  id: Generated<string>;
  centre_id: string;
  name: string;
  capacity: number;
  equipment: string | null;
  status: Status;
  created_at: Timestamp;
}

export interface StudiesTable {
  id: Generated<string>;
  centre_id: string;
  subject_id: string;
  name: string;
  billing_mode: "monthly" | "per_session";
  price: number;
  absence_billed: Generated<boolean>;
  sessions_per_week: number;
  capacity: number;
  status: Status;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TrainingsTable {
  id: Generated<string>;
  centre_id: string;
  title: string;
  category: string | null;
  description: string | null;
  duration_hours: number;
  price: number;
  capacity: number;
  payment_modes: "full" | "installments" | "both";
  status: Status;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface PaymentPlansTable {
  id: Generated<string>;
  centre_id: string;
  training_id: string;
  name: string;
  is_default: Generated<boolean>;
  status: Status;
  created_at: Timestamp;
}

export interface PaymentPlanItemsTable {
  id: Generated<string>;
  plan_id: string;
  position: number;
  label: string;
  value_kind: "percent" | "amount";
  value: number;
  due_kind: "relative" | "fixed";
  due_offset_days: number | null;
  due_date: NullableDate;
}

export interface TrainingSessionsTable {
  id: Generated<string>;
  centre_id: string;
  training_id: string;
  name: string;
  start_date: DateColumn;
  end_date: DateColumn;
  status: Generated<"open" | "closed">;
  created_at: Timestamp;
}

export interface GroupsTable {
  id: Generated<string>;
  centre_id: string;
  kind: "study" | "training";
  study_id: string | null;
  training_session_id: string | null;
  name: string;
  instructor_id: string;
  room_id: string | null;
  capacity: number;
  start_date: DateColumn;
  end_date: DateColumn;
  price_override: number | null;
  absence_billed_override: boolean | null;
  count_justified_override: boolean | null;
  count_makeup_override: boolean | null;
  status: Status;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface GroupSlotsTable {
  id: Generated<string>;
  group_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  room_id: string | null;
}

export type EnrolmentStatus = "active" | "transferred" | "dropped" | "completed";
export type PaymentMode = "full" | "installments" | "monthly" | "per_session";

export interface EnrolmentsTable {
  id: Generated<string>;
  centre_id: string;
  student_id: string;
  group_id: string;
  effective_date: DateColumn;
  end_date: NullableDate;
  status: Generated<EnrolmentStatus>;
  payment_mode: PaymentMode;
  plan_id: string | null;
  transferred_from_id: string | null;
  ended_reason: string | null;
  created_by: string | null;
  created_at: Timestamp;
}

export interface InstallmentsTable {
  id: Generated<string>;
  centre_id: string;
  enrolment_id: string | null;
  rental_id: ColumnType<string | null, string | null | undefined, string | null>;
  label: string;
  kind: "charge" | "discount";
  amount: number;
  due_date: DateColumn;
  original_due_date: DateColumn;
  postponement_count: Generated<number>;
  discount_status: "pending" | "approved" | "rejected" | null;
  status: Generated<"open" | "cancelled">;
  cancelled_at: NullableTimestamp;
  cancelled_by: string | null;
  cancel_reason: string | null;
  carried_from_id: string | null;
  session_id: string | null;
  created_by: string | null;
  created_at: Timestamp;
}

export type SessionStatus = "scheduled" | "held" | "cancelled";
export type SheetStatus = "none" | "in_progress" | "validated";
export type AttendanceStatusColumn = "present" | "absent" | "absent_justified" | "present_other_group";

export interface ClassSessionsTable {
  id: Generated<string>;
  centre_id: string;
  group_id: string;
  instructor_id: string;
  room_id: string | null;
  starts_at: ColumnType<Date, Date | string, Date | string>;
  ends_at: ColumnType<Date, Date | string, Date | string>;
  status: Generated<SessionStatus>;
  cancel_reason: string | null;
  sheet_status: Generated<SheetStatus>;
  validated_at: NullableTimestamp;
  validated_by: string | null;
  created_at: Timestamp;
}

export interface RoomBookingsTable {
  id: Generated<string>;
  centre_id: string;
  room_id: string;
  period: string;
  session_id: string | null;
  rental_slot_id: ColumnType<string | null, string | null | undefined, string | null>;
  active: Generated<boolean>;
}

export interface AttendanceRecordsTable {
  id: Generated<string>;
  centre_id: string;
  session_id: string;
  student_id: string;
  enrolment_id: string;
  status: AttendanceStatusColumn;
  is_guest: Generated<boolean>;
  host_session_id: string | null;
  note: string | null;
  updated_at: Timestamp;
  updated_by: string | null;
}

export interface FinancialEventsTable {
  id: Generated<number>;
  centre_id: string;
  at: Timestamp;
  event_type: string;
  amount: number;
  user_id: string | null;
  student_id: string | null;
  enrolment_id: string | null;
  group_id: string | null;
  study_id: string | null;
  training_id: string | null;
  instructor_id: string | null;
  room_id: string | null;
  installment_id: string | null;
  rental_id: ColumnType<string | null, string | null | undefined, string | null>;
  renter_id: ColumnType<string | null, string | null | undefined, string | null>;
  payload: Json;
}

export type PaymentMethod = "cash" | "transfer" | "cheque" | "card";
export type ChequeStatus = "received" | "deposited" | "cashed" | "bounced";

export interface PaymentsTable {
  id: Generated<string>;
  centre_id: string;
  kind: Generated<"payment" | "refund">;
  student_id: string | null;
  renter_id: ColumnType<string | null, string | null | undefined, string | null>;
  received_at: Timestamp;
  amount: number;
  method: PaymentMethod;
  cheque_number: string | null;
  cheque_bank: string | null;
  cheque_status: ChequeStatus | null;
  reference: string | null;
  note: string | null;
  status: Generated<"valid" | "cancelled">;
  cancelled_at: NullableTimestamp;
  cancelled_by: string | null;
  cancel_reason: string | null;
  created_by: string | null;
  created_at: Timestamp;
}

export interface AllocationsTable {
  id: Generated<string>;
  centre_id: string;
  payment_id: string | null;
  discount_id: string | null;
  installment_id: string;
  amount: number;
  created_by: string | null;
  created_at: Timestamp;
}

export interface ReceiptCountersTable {
  centre_id: string;
  year: number;
  last_number: number;
}

export interface ReceiptsTable {
  id: Generated<string>;
  centre_id: string;
  number: string;
  year: number;
  sequence: number;
  kind: "payment" | "refund" | "cancellation";
  payment_id: string;
  cancels_receipt_id: string | null;
  issued_at: Timestamp;
  snapshot: Json;
  pdf: Buffer;
  sha256: string;
  created_by: string | null;
}

export interface ReceiptPrintsTable {
  id: Generated<string>;
  receipt_id: string;
  printed_at: Timestamp;
  printed_by: string | null;
  duplicate: boolean;
}

export interface MailDispatchesTable {
  id: Generated<string>;
  centre_id: string;
  kind: "receipt" | "reminder";
  receipt_id: string | null;
  student_id: string | null;
  renter_id: ColumnType<string | null, string | null | undefined, string | null>;
  recipient: string;
  status: "sent" | "failed";
  error: string | null;
  sent_at: Timestamp;
  sent_by: string | null;
}

export interface PostponementsTable {
  id: Generated<string>;
  centre_id: string;
  installment_id: string;
  from_date: DateColumn;
  to_date: DateColumn;
  reason: string;
  requested_by: string | null;
  requested_at: Timestamp;
  status: "pending" | "approved" | "rejected";
  decided_by: string | null;
  decided_at: NullableTimestamp;
  decision_reason: string | null;
}

export type PayBaseKind = "pct_collections" | "pct_session_tariff" | "fixed_per_session" | "monthly_flat" | "hourly" | "training_flat";
export type PresenceKind = "ignore" | "prorata" | "session_due" | "threshold";

export interface PayRulesTable {
  id: Generated<string>;
  centre_id: string;
  instructor_id: string;
  scope: "instructor" | "study" | "training" | "group";
  study_id: string | null;
  training_id: string | null;
  group_id: string | null;
  base_kind: PayBaseKind;
  basis_points: number | null;
  amount: number | null;
  collection_basis: "collected" | "invoiced" | null;
  presence_kind: PresenceKind;
  min_rate_basis_points: number | null;
  floor_amount: number | null;
  prorata_above: boolean | null;
  valid_from: DateColumn;
  valid_to: NullableDate;
  status: Status;
  created_by: string | null;
  created_at: Timestamp;
}

export interface PayPeriodsTable {
  id: Generated<string>;
  centre_id: string;
  month: DateColumn;
  status: Generated<"draft" | "calculated" | "validated" | "paid">;
  calculated_at: NullableTimestamp;
  validated_at: NullableTimestamp;
  validated_by: string | null;
  created_at: Timestamp;
}

export interface PayLinesTable {
  id: Generated<string>;
  period_id: string;
  instructor_id: string;
  group_id: string | null;
  rule_id: string;
  rule_snapshot: Json;
  base: number;
  rate_numerator: number;
  rate_denominator: number;
  amount: number;
  details: Json;
}

export interface PayAdjustmentsTable {
  id: Generated<string>;
  period_id: string;
  instructor_id: string;
  kind: "bonus" | "deduction";
  amount: number;
  reason: string;
  created_by: string | null;
  created_at: Timestamp;
}

export interface PayslipsTable {
  id: Generated<string>;
  period_id: string;
  instructor_id: string;
  total: number;
  pdf: Buffer;
  sha256: string;
  issued_at: Timestamp;
  paid_on: NullableDate;
  payment_method: "cash" | "transfer" | "cheque" | null;
  payment_reference: string | null;
  paid_by: string | null;
}

export type RentalUnit = "hour" | "half_day" | "day" | "month" | "year";

export interface RoomRatesTable {
  room_id: string;
  unit: RentalUnit;
  amount: number;
}

export interface RentersTable {
  id: Generated<string>;
  centre_id: string;
  name: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  created_at: Timestamp;
}

export interface RentalsTable {
  id: Generated<string>;
  centre_id: string;
  renter_id: string;
  room_id: string;
  unit: RentalUnit;
  quantity: number;
  unit_price: number;
  total: number;
  payment_mode: "full" | "deposit_balance" | "recurring";
  status: Generated<"active" | "cancelled">;
  cancelled_at: NullableTimestamp;
  cancel_reason: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: Timestamp;
}

export interface RentalSlotsTable {
  id: Generated<string>;
  rental_id: string;
  starts_at: ColumnType<Date, Date | string, Date | string>;
  ends_at: ColumnType<Date, Date | string, Date | string>;
}

export interface CashClosingsTable {
  id: Generated<string>;
  centre_id: string;
  day: DateColumn;
  expected_cash: number;
  counted_cash: number;
  difference: number;
  comment: string | null;
  totals: Json;
  closed_by: string;
  closed_at: Timestamp;
}

export interface Database {
  centres: CentresTable;
  users: UsersTable;
  sessions: SessionsTable;
  audit_log: AuditLogTable;
  students: StudentsTable;
  subjects: SubjectsTable;
  instructors: InstructorsTable;
  instructor_subjects: InstructorSubjectsTable;
  instructor_availability: InstructorAvailabilityTable;
  rooms: RoomsTable;
  studies: StudiesTable;
  trainings: TrainingsTable;
  payment_plans: PaymentPlansTable;
  payment_plan_items: PaymentPlanItemsTable;
  training_sessions: TrainingSessionsTable;
  groups: GroupsTable;
  group_slots: GroupSlotsTable;
  enrolments: EnrolmentsTable;
  installments: InstallmentsTable;
  financial_events: FinancialEventsTable;
  class_sessions: ClassSessionsTable;
  room_bookings: RoomBookingsTable;
  attendance_records: AttendanceRecordsTable;
  payments: PaymentsTable;
  allocations: AllocationsTable;
  effective_allocations: AllocationsTable;
  receipt_counters: ReceiptCountersTable;
  receipts: ReceiptsTable;
  receipt_prints: ReceiptPrintsTable;
  mail_dispatches: MailDispatchesTable;
  postponements: PostponementsTable;
  pay_rules: PayRulesTable;
  pay_periods: PayPeriodsTable;
  pay_lines: PayLinesTable;
  pay_adjustments: PayAdjustmentsTable;
  payslips: PayslipsTable;
  room_rates: RoomRatesTable;
  renters: RentersTable;
  rentals: RentalsTable;
  rental_slots: RentalSlotsTable;
  cash_closings: CashClosingsTable;
}

export type Student = Selectable<StudentsTable>;
export type NewStudent = Insertable<StudentsTable>;
export type StudentUpdate = Updateable<StudentsTable>;
