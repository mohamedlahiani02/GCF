/** Shapes returned by the GCF API (dates as ISO strings, amounts as integer millimes). */

export interface Totals {
  due: number;
  credit: number;
  pendingDiscounts: number;
}

export interface StudentRow {
  id: string;
  firstName: string;
  lastName: string;
  birthDate: string | null;
  isMinor: boolean;
  phone: string | null;
  email: string | null;
  receiptEmail: string | null;
  guardianName: string | null;
  guardianPhone: string | null;
  guardianEmail: string | null;
  notes: string | null;
  status: "active" | "archived";
  activeGroups?: string[];
  due?: number;
  lastPaymentAt?: string | null;
}

export interface Installment {
  id: string;
  enrolmentId: string | null;
  rentalId: string | null;
  label: string;
  kind: "charge" | "discount";
  amount: number;
  dueDate: string;
  originalDueDate: string;
  postponementCount: number;
  discountStatus: "pending" | "approved" | "rejected" | null;
  status: "open" | "cancelled";
  paid: number;
  remaining: number;
  state: string;
}

export interface PaymentRow {
  id: string;
  kind: "payment" | "refund";
  receivedAt: string;
  amount: number;
  method: "cash" | "transfer" | "cheque" | "card";
  chequeNumber?: string | null;
  chequeStatus: string | null;
  status: "valid" | "cancelled";
  cancelReason?: string | null;
  receiptId: string | null;
  receiptNumber: string | null;
}

export interface StudentAccount {
  student: {
    id: string;
    firstName: string;
    lastName: string;
    isMinor: boolean;
    guardianName: string | null;
    phone: string | null;
    email: string | null;
    receiptEmail: string | null;
  };
  totals: Totals;
  installments: Installment[];
  payments: PaymentRow[];
  postponements: {
    id: string;
    installmentId: string;
    label: string;
    fromDate: string;
    toDate: string;
    reason: string;
    status: string;
    requestedAt: string;
    decisionReason: string | null;
  }[];
  timeline: { at: string; type: string; label: string; detail: string | null }[];
}

export interface EnrolmentRow {
  id: string;
  studentId: string;
  firstName: string;
  lastName: string;
  groupId: string;
  groupName: string;
  kind: "study" | "training";
  studyName: string | null;
  trainingTitle: string | null;
  effectiveDate: string;
  endDate: string | null;
  status: "active" | "transferred" | "dropped" | "completed";
  paymentMode: string;
  transferredFromId: string | null;
  endedReason: string | null;
}

export interface Slot {
  id?: string;
  weekday: number;
  startTime: string;
  endTime: string;
  roomId: string | null;
}

export interface GroupDetail {
  id: string;
  kind: "study" | "training";
  name: string;
  studyId: string | null;
  studyName: string | null;
  trainingSessionId: string | null;
  trainingId: string | null;
  trainingTitle: string | null;
  trainingSessionName: string | null;
  instructorId: string;
  instructorFirstName: string;
  instructorLastName: string;
  roomId: string | null;
  roomName: string | null;
  capacity: number;
  startDate: string;
  endDate: string;
  priceOverride: number | null;
  billingMode: "monthly" | "per_session" | null;
  status: string;
  effective: { price: number; absenceBilled: boolean | null; countJustifiedAsPresent: boolean; countMakeupAsPresent: boolean };
  slots: Slot[];
  enrolledCount: number;
  students: { enrolmentId: string; studentId: string; firstName: string; lastName: string; isMinor: boolean; effectiveDate: string }[];
}

export interface GroupRow {
  id: string;
  kind: "study" | "training";
  name: string;
  studyId: string | null;
  studyName: string | null;
  trainingSessionId: string | null;
  trainingSessionName: string | null;
  trainingId: string | null;
  trainingTitle: string | null;
  instructorId: string;
  instructorFirstName: string;
  instructorLastName: string;
  roomId: string | null;
  roomName: string | null;
  capacity: number;
  startDate: string;
  endDate: string;
  status: string;
  enrolledCount: number;
  nextSessionId: string | null;
  nextSessionAt: string | null;
  attendanceSessionId: string | null;
  slots: Slot[];
}

export interface GroupSession {
  id: string;
  startsAt: string;
  endsAt: string;
  status: "scheduled" | "held" | "cancelled";
  sheetStatus: "none" | "in_progress" | "validated";
  roomId: string | null;
  roomName: string | null;
  instructorId: string;
  instructorName: string;
}

export interface Room {
  id: string;
  name: string;
  capacity: number;
  equipment: string | null;
  status: string;
}

export interface Instructor {
  id: string;
  firstName: string;
  lastName: string;
  kind: "teacher" | "trainer";
  employment: "salaried" | "freelance" | "contractor";
  phone: string | null;
  email: string | null;
  status: string;
  activeGroups?: number;
}

export interface Study {
  id: string;
  subjectId: string;
  name: string;
  billingMode: "monthly" | "per_session";
  price: number;
  absenceBilled: boolean;
  sessionsPerWeek: number;
  capacity: number;
  status: string;
  groupCount: number;
  studentCount: number;
}

export interface PlanItem {
  label: string;
  valueKind: "percent" | "amount";
  value: number;
  dueKind: "relative" | "fixed";
  dueOffsetDays: number | null;
  dueDate: string | null;
}

export interface TrainingDetail {
  id: string;
  title: string;
  category: string | null;
  description: string | null;
  durationHours: number;
  price: number;
  capacity: number;
  status: string;
  plans: {
    id: string;
    name: string;
    isDefault: boolean;
    kind: "full" | "installments" | "monthly" | "per_session";
    amount: number | null;
    absenceBilled: boolean | null;
    status: string;
    items: PlanItem[];
    amounts: number[];
  }[];
  sessions: { id: string; name: string; startDate: string; endDate: string; status: string }[];
}

export interface SheetRow {
  studentId: string;
  enrolmentId: string;
  firstName: string;
  lastName: string;
  status: "present" | "absent" | "absent_justified" | "present_other_group";
  saved: boolean;
  isGuest: boolean;
  originGroupName: string | null;
  hostSessionId: string | null;
  note: string | null;
}

export interface Sheet {
  session: {
    id: string;
    groupId: string;
    groupName: string;
    instructorId: string;
    startsAt: string;
    endsAt: string;
    localDate: string;
    status: string;
    sheetStatus: "none" | "in_progress" | "validated";
  };
  rows: SheetRow[];
  counters: { present: number; absent: number; absentJustified: number; presentOtherGroup: number; guests: number };
}

export interface DaySession {
  id: string;
  groupId: string;
  groupName: string;
  startsAt: string;
  endsAt: string;
  instructorFirstName: string;
  instructorLastName: string;
  roomName: string | null;
  status: string;
  sheetStatus: "none" | "in_progress" | "validated";
}
