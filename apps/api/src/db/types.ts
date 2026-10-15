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
  enrolment_id: string;
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
  created_by: string | null;
  created_at: Timestamp;
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
  payload: Json;
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
}

export type Student = Selectable<StudentsTable>;
export type NewStudent = Insertable<StudentsTable>;
export type StudentUpdate = Updateable<StudentsTable>;
