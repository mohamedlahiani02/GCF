import type { CwBookingStatus, CwCategory, FloorLayout, PlanState, SiteLanguage } from "@gcf/shared";

/** Response shapes of the client portal API (apps/api/src/routes/portal). Instants arrive as ISO strings. */

export type Profile = "visitor" | "member";
export type QuotaKind = "unlimited" | "minutes" | "bookings";
export type InstallmentState = "paid" | "partial" | "overdue" | "postponed" | "upcoming" | "cancelled" | "pending_discount" | "discount" | "rejected_discount";

export interface PortalInfo {
  portalEnabled: boolean;
  centre: { name: string; address: string | null };
  logoUrl: string | null;
  selfSignup: "open" | "validated" | "closed";
  languages: SiteLanguage[];
  colors: { primary: string; secondary: string } | null;
  openingHours: { from: string; to: string; weekdays: number[] };
  /** IANA time zone of the centre; every instant is shown in it. */
  timezone: string;
}

export interface Member {
  id: string;
  email: string | null;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  emailVerified: boolean;
  company: { id: string; name: string; role: "admin" | "member" } | null;
}

export interface MemberProfile {
  member: Member;
}

export type SignupResult = { status: "pending" } | ({ status: "active" } & MemberProfile);

export interface FormatOffer {
  id: string;
  label: string;
  nature: "fixed" | "named" | "free";
  durationMinutes: number | null;
  startStepMinutes: number | null;
  startTime: string | null;
  endTime: string | null;
  minMinutes: number | null;
  maxMinutes: number | null;
  weekdays: number[];
  price: { amount: number; offpeakAmount: number | null; perHour: boolean; profile: Profile };
}

export interface CatalogueType {
  id: string;
  name: string;
  category: CwCategory;
  description: string | null;
  photoUrl: string | null;
  requiresApproval: boolean;
  maxMinutesPerDay: number | null;
  capacity: { min: number; max: number };
  floors: { id: string; name: string }[];
  formats: FormatOffer[];
}

export interface Catalogue {
  date: string;
  profile: Profile;
  offpeakFrom: string | null;
  rules: {
    approvalMode: "none" | "visitors" | "all";
    bookingHorizonDays: number;
    horizonEnd: string;
    minNoticeMinutes: number;
    maxActiveBookings: number;
    freeCancelHours: number;
    lateCancelFeeBp: number;
  };
  types: CatalogueType[];
}

export interface Slot {
  startTime: string;
  endTime: string;
  minutes: number;
  startsAt: string;
  endsAt: string;
  free: number;
}

export interface Slots {
  date: string;
  open: { from: string; to: string } | null;
  closures: string[];
  horizonEnd: string;
  slots: Slot[];
}

export interface FloorResourceState {
  resourceId: string;
  code: string;
  name: string | null;
  typeId: string;
  typeName: string;
  category: CwCategory;
  capacity: number;
  zoneId: string | null;
  status: string;
  state: PlanState;
}

export interface FloorStateResponse {
  floor: { id: string; name: string; layout: FloorLayout; planMediaId: string | null };
  resources: FloorResourceState[];
}

export interface BookingInput {
  resourceId: string;
  formatId: string;
  date: string;
  startTime: string;
  durationMinutes?: number;
  promoCode?: string;
  notes?: string;
}

export interface Quote {
  profile: Profile;
  resource: { id: string; code: string; typeId: string; typeName: string; category: CwCategory };
  format: { id: string; label: string; nature: string };
  date: string;
  startTime: string;
  endTime: string;
  minutes: number;
  listPrice: number;
  offpeak: boolean;
  coverage: { coveredMinutes: number; discount: number; sources: { kind: "subscription" | "pack"; label: string; coveredMinutes: number }[] };
  promotion: { code: string; discount: number } | null;
  charge: number;
  status: "requested" | "confirmed";
}

export interface Booking {
  id: string;
  status: CwBookingStatus;
  resourceId: string;
  resourceCode: string;
  resourceName: string | null;
  typeId: string;
  typeName: string;
  category: CwCategory;
  floorId: string;
  floorName: string;
  formatLabel: string | null;
  date: string;
  startTime: string;
  endTime: string;
  startsAt: string;
  endsAt: string;
  profile: Profile | null;
  listPrice: number;
  coveredMinutes: number;
  coverageDiscount: number;
  promoDiscount: number;
  charge: number;
  lateCancelFee: number;
  requestedAt: string;
  refusalReason: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  checkedInAt: string | null;
  paid: number;
  due: number;
  cancellable: boolean;
  cancellation: { free: boolean; fee: number; freeUntil: string } | null;
  qrAvailable: boolean;
}

export interface BookingCharge {
  id: string;
  label: string;
  amount: number;
  dueDate: string;
  paid: number;
  remaining: number;
  state: InstallmentState;
}

export interface BookingDetail extends Booking {
  charges: BookingCharge[];
}

export interface CancelResult extends Booking {
  free: boolean;
  fee: number;
}

export interface Page<T> {
  items: T[];
  hasMore: boolean;
  page: number;
}

export interface Entitlement {
  typeId: string;
  typeName: string | null;
  category: CwCategory | null;
  quotaKind: QuotaKind;
  quota: number | null;
  used: number | null;
  remaining: number | null;
}

export interface Subscription {
  id: string;
  planName: string;
  startsOn: string;
  endsOn: string;
  price: number;
  billing: "upfront" | "monthly";
  includesDomiciliation: boolean;
  assignedResourceId: string | null;
  assignedResourceCode: string | null;
  autoRenew: boolean;
  state: "current" | "upcoming";
  window: { start: string; end: string };
  entitlements: Entitlement[];
}

export interface Pack {
  id: string;
  productName: string;
  typeId: string;
  typeName: string;
  category: CwCategory;
  quotaKind: Exclude<QuotaKind, "unlimited">;
  quota: number;
  price: number;
  startsOn: string;
  expiresOn: string;
  status: string;
  used: number;
  remaining: number;
  state: "active" | "used_up" | "expired" | "cancelled";
}

export interface Account {
  totals: { due: number; credit: number; pendingDiscounts: number };
  installments: {
    id: string;
    label: string;
    kind: "charge" | "discount";
    amount: number;
    dueDate: string;
    status: "open" | "cancelled";
    paid: number;
    remaining: number;
    state: InstallmentState;
    cwBookingId: string | null;
    cwSubscriptionId: string | null;
    cwPackId: string | null;
  }[];
  payments: {
    id: string;
    kind: "payment" | "refund";
    receivedAt: string;
    amount: number;
    method: "cash" | "transfer" | "cheque" | "card";
    chequeStatus: string | null;
    status: "valid" | "cancelled";
    receiptId: string | null;
    receiptNumber: string | null;
  }[];
}

export interface MailItem {
  id: string;
  receivedAt: string;
  kind: "letter" | "registered" | "parcel" | "other";
  sender: string | null;
  reference: string | null;
  status: "received" | "notified" | "collected" | "returned";
  notifiedAt: string | null;
  collectedAt: string | null;
  collectedByName: string | null;
}

export interface Team {
  company: { id: string; name: string };
  members: {
    id: string;
    firstName: string;
    lastName: string | null;
    companyRole: "admin" | "member" | null;
    status: "pending" | "active" | "disabled";
    upcomingBookings: number;
    isMe: boolean;
  }[];
}

export interface TeamBooking {
  id: string;
  memberId: string;
  memberName: string;
  date: string;
  startTime: string;
  endTime: string;
  startsAt: string;
  endsAt: string;
  resourceCode: string;
  typeName: string;
  category: CwCategory;
  status: CwBookingStatus;
}
