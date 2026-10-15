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
  majority_age: Generated<number>;
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

export interface Database {
  centres: CentresTable;
  users: UsersTable;
  sessions: SessionsTable;
  audit_log: AuditLogTable;
  students: StudentsTable;
}

export type Student = Selectable<StudentsTable>;
export type NewStudent = Insertable<StudentsTable>;
export type StudentUpdate = Updateable<StudentsTable>;
