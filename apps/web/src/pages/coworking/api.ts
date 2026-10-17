import { CW_CATEGORY_LABELS, percentOf, type CwBookingStatus, type CwCategory, type FloorLayout, type PlanState } from "@gcf/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { Tone } from "../../lib/labels";

/** Shapes of the coworking operations API (apps/api/src/routes/coworking), dates as ISO strings, money in millimes. */

export type Profile = "visitor" | "member";
export type QuotaKind = "unlimited" | "minutes" | "bookings";

export interface Settings {
  bookingHorizonDays: number;
  minNoticeMinutes: number;
  maxActiveBookings: number;
  approvalMode: "none" | "visitors" | "all";
  freeCancelHours: number;
  lateCancelFeeBp: number;
  noShowGraceMinutes: number | null;
  requestExpiryHours: number;
  offpeakFrom: string | null;
}

export interface Floor {
  id: string;
  name: string;
  position: number;
  status: "active" | "archived";
  planMediaId: string | null;
  resourceCount: number;
}

export interface FloorDetail extends Floor {
  layout: FloorLayout;
  planWidth: number | null;
  planHeight: number | null;
  zones: { id: string; name: string; color: string }[];
}

export interface ResourceType {
  id: string;
  name: string;
  category: CwCategory;
  requiresApproval: boolean;
  maxMinutesPerDay: number | null;
  bufferMinutes: number;
  status: "active" | "archived";
}

export interface Resource {
  id: string;
  code: string;
  name: string | null;
  typeId: string;
  typeName: string;
  category: CwCategory;
  floorId: string;
  floorName: string;
  status: "active" | "out_of_service" | "archived";
}

export interface Format {
  id: string;
  typeId: string;
  label: string;
  nature: "fixed" | "named" | "free";
  durationMinutes: number | null;
  startStepMinutes: number | null;
  startTime: string | null;
  endTime: string | null;
  minMinutes: number | null;
  maxMinutes: number | null;
  weekdays: number[];
  prices: { profile: Profile; amount: number; offpeakAmount: number | null }[];
}

export interface Slot {
  startTime: string;
  endTime: string;
  minutes: number;
  startsAt: string;
  endsAt: string;
  free: number;
}

export interface SlotsResponse {
  date: string;
  open: { from: string; to: string } | null;
  closures: string[];
  slots: Slot[];
}

export interface Occupant {
  bookingId: string;
  kind: "booking" | "block";
  status: CwBookingStatus;
  startsAt: string;
  endsAt: string;
  memberId: string | null;
  memberName: string | null;
  phone: string | null;
  company: string | null;
  charge: number;
  paid: number;
  notes: string | null;
}

export interface ResourceState {
  resourceId: string;
  code: string;
  name: string | null;
  typeId: string;
  typeName: string;
  category: CwCategory;
  capacity: number;
  status: "active" | "out_of_service" | "archived";
  state: PlanState;
  occupant?: Occupant;
  subscriber?: { memberId: string; memberName: string; company: string | null; endsOn: string };
}

export interface FloorState {
  floor: { id: string; name: string; layout: FloorLayout };
  resources: ResourceState[];
}

export interface PlanningBooking {
  id: string;
  kind: "booking" | "block";
  resourceId: string;
  status: CwBookingStatus;
  startsAt: string;
  endsAt: string;
  blockedUntil: string;
  memberId: string | null;
  memberName: string | null;
  company: string | null;
  charge: number;
  notes: string | null;
}

export interface PlanningDay {
  date: string;
  open: { from: string; to: string } | null;
  closures: string[];
  floors: {
    id: string;
    name: string;
    resources: {
      id: string;
      code: string;
      name: string | null;
      status: string;
      typeId: string;
      typeName: string;
      category: CwCategory;
      bookings: PlanningBooking[];
    }[];
  }[];
}

export interface RequestRow {
  id: string;
  startsAt: string;
  endsAt: string;
  requestedAt: string;
  expiresAt: string;
  profile: Profile;
  charge: number;
  notes: string | null;
  resourceId: string;
  resourceCode: string;
  typeName: string;
  memberId: string;
  memberName: string;
  phone: string | null;
  email: string | null;
  company: string | null;
}

export interface BookingListRow {
  id: string;
  kind: "booking" | "block";
  status: CwBookingStatus;
  source: "portal" | "staff";
  startsAt: string;
  endsAt: string;
  resourceId: string;
  resourceCode: string;
  typeName: string;
  formatLabel: string | null;
  memberId: string | null;
  memberName: string | null;
  company: string | null;
  profile: Profile | null;
  listPrice: number;
  charge: number;
  lateCancelFee: number;
  notes: string | null;
}

export interface ChargeBalance {
  id: string;
  label: string;
  kind: "charge" | "discount";
  amount: number;
  dueDate: string;
  originalDueDate: string;
  status: "open" | "cancelled";
  paid: number;
  remaining: number;
  state: string;
  cwBookingId: string | null;
  cwSubscriptionId: string | null;
  cwPackId: string | null;
}

export interface Booking {
  id: string;
  kind: "booking" | "block";
  status: CwBookingStatus;
  source: "portal" | "staff";
  resourceId: string;
  resourceCode: string;
  typeId: string;
  typeName: string;
  category: CwCategory;
  floorId: string;
  formatId: string | null;
  formatLabel: string | null;
  memberId: string | null;
  memberName: string | null;
  memberEmail: string | null;
  memberPhone: string | null;
  startsAt: string;
  endsAt: string;
  blockedUntil: string;
  localDate: string;
  startTime: string;
  endTime: string;
  profile: Profile | null;
  listPrice: number;
  coveredMinutes: number;
  coverageDiscount: number;
  promoDiscount: number;
  charge: number;
  lateCancelFee: number;
  checkedInAt: string | null;
  requestedAt: string;
  decidedAt: string | null;
  refusalReason: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  notes: string | null;
}

export interface BookingDetail extends Booking {
  charges: ChargeBalance[];
  paid: number;
  due: number;
  usage: {
    id: string;
    subscriptionId: string | null;
    packId: string | null;
    label: string;
    quotaKind: QuotaKind;
    amount: number;
    windowStart: string | null;
    status: "active" | "released";
  }[];
  accessEvents: { id: string; at: string; source: "staff" | "qr"; recordedBy: string | null }[];
}

export interface Quote {
  memberId: string;
  profile: Profile;
  resource: { id: string; code: string; typeId: string; typeName: string; category: CwCategory };
  format: { id: string; label: string; nature: string };
  date: string;
  startTime: string;
  endTime: string;
  minutes: number;
  startsAt: string;
  endsAt: string;
  listPrice: number;
  offpeak: boolean;
  coverage: {
    coveredMinutes: number;
    discount: number;
    sources: { kind: "subscription" | "pack"; id: string; label: string; quotaKind: QuotaKind; amount: number; coveredMinutes: number }[];
  };
  promotion: { id: string; code: string; kind: "percent" | "amount"; value: number; discount: number } | null;
  charge: number;
  status: "requested" | "confirmed";
  warnings: { code: string; message: string }[];
}

export interface BookingInput {
  memberId: string;
  resourceId: string;
  formatId: string;
  date: string;
  startTime: string;
  durationMinutes?: number;
  promoCode?: string;
  notes?: string;
  override?: boolean;
}

export interface MemberRow {
  id: string;
  kind: "member" | "guest";
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  companyId: string | null;
  companyName: string | null;
  status: "pending" | "active" | "disabled";
  notes: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  hasPassword: boolean;
  currentPlan?: string | null;
}

export interface Pack {
  id: string;
  memberId: string;
  productId: string;
  productName: string;
  typeId: string;
  typeName: string;
  quotaKind: "minutes" | "bookings";
  quota: number;
  price: number;
  startsOn: string;
  expiresOn: string;
  status: "active" | "cancelled";
  cancelReason: string | null;
  used: number;
  remaining: number;
  state: "active" | "expired" | "used_up" | "cancelled";
}

export interface MemberDetail extends MemberRow {
  activeSubscription: {
    id: string;
    planId: string;
    planName: string;
    startsOn: string;
    endsOn: string;
    includesDomiciliation: boolean;
    autoRenew: boolean;
    assignedResourceId: string | null;
    assignedResourceCode: string | null;
  } | null;
  packs: Pack[];
  bookingsLast30Days: number;
  upcomingBookings: number;
  noShowsLast90Days: number;
  openMailCount: number;
  totals: { due: number; credit: number; pendingDiscounts: number };
}

export interface MemberAccount {
  member: MemberRow;
  totals: { due: number; credit: number; pendingDiscounts: number };
  installments: ChargeBalance[];
  payments: {
    id: string;
    kind: "payment" | "refund";
    receivedAt: string;
    amount: number;
    method: string;
    chequeStatus: string | null;
    status: "valid" | "cancelled";
    cancelReason: string | null;
    receiptId: string | null;
    receiptNumber: string | null;
  }[];
}

export type SubscriptionState = "current" | "upcoming" | "ended" | "cancelled";

export interface Subscription {
  id: string;
  memberId: string;
  memberName: string;
  planId: string;
  planName: string;
  startsOn: string;
  endsOn: string;
  price: number;
  billing: "upfront" | "monthly";
  includesDomiciliation: boolean;
  assignedResourceId: string | null;
  assignedResourceCode: string | null;
  autoRenew: boolean;
  renewalId: string | null;
  status: "active" | "cancelled";
  cancelReason: string | null;
  state: SubscriptionState;
  due: number;
  overdue: number;
}

export interface Plan {
  id: string;
  name: string;
  period: "month" | "quarter" | "year";
  price: number;
  billing: "upfront" | "monthly";
  includesDomiciliation: boolean;
  assignedTypeId: string | null;
  status: "active" | "archived";
}

export interface PackProduct {
  id: string;
  name: string;
  typeId: string;
  quotaKind: "minutes" | "bookings";
  quota: number;
  validityDays: number;
  price: number;
  status: "active" | "archived";
}

export type MailKind = "letter" | "registered" | "parcel" | "other";
export type MailStatus = "received" | "notified" | "collected" | "returned";

export interface MailItem {
  id: string;
  memberId: string;
  memberName: string;
  receivedAt: string;
  kind: MailKind;
  sender: string | null;
  reference: string | null;
  status: MailStatus;
  notifiedAt: string | null;
  collectedAt: string | null;
  collectedByName: string | null;
  handedBy: string | null;
  notes: string | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/* Wording and badge colours */

export const CATEGORY = CW_CATEGORY_LABELS.fr;

export const BOOKING_STATUS: Record<CwBookingStatus, { label: string; tone: Tone }> = {
  requested: { label: "Demande", tone: "amber" },
  confirmed: { label: "Confirmée", tone: "blue" },
  checked_in: { label: "Arrivé", tone: "violet" },
  completed: { label: "Terminée", tone: "green" },
  cancelled: { label: "Annulée", tone: "gray" },
  refused: { label: "Refusée", tone: "red" },
  expired: { label: "Expirée", tone: "gray" },
  no_show: { label: "Absent", tone: "red" },
};

export const PLAN_STATE: Record<PlanState, string> = {
  free: "Libre",
  requested: "Demande en attente",
  booked: "Réservé",
  occupied: "Occupé",
  blocked: "Bloqué ou hors service",
  assigned: "Attribué",
};

export const PROFILE: Record<Profile, string> = { visitor: "Visiteur", member: "Abonné" };
export const MEMBER_KIND: Record<MemberRow["kind"], string> = { member: "Membre", guest: "Client de passage" };
export const MEMBER_STATUS: Record<MemberRow["status"], { label: string; tone: Tone }> = {
  pending: { label: "À valider", tone: "amber" },
  active: { label: "Actif", tone: "green" },
  disabled: { label: "Désactivé", tone: "gray" },
};
export const SUBSCRIPTION_STATE: Record<SubscriptionState, { label: string; tone: Tone }> = {
  current: { label: "En cours", tone: "green" },
  upcoming: { label: "À venir", tone: "blue" },
  ended: { label: "Terminé", tone: "gray" },
  cancelled: { label: "Annulé", tone: "gray" },
};
export const PACK_STATE: Record<Pack["state"], { label: string; tone: Tone }> = {
  active: { label: "Actif", tone: "green" },
  expired: { label: "Expiré", tone: "gray" },
  used_up: { label: "Épuisé", tone: "neutral" },
  cancelled: { label: "Annulé", tone: "gray" },
};
export const PERIOD: Record<Plan["period"], string> = { month: "Mensuel", quarter: "Trimestriel", year: "Annuel" };
export const BILLING: Record<Plan["billing"], string> = { upfront: "Paiement à la souscription", monthly: "Paiement mensuel" };
export const QUOTA: Record<QuotaKind, string> = { unlimited: "Illimité", minutes: "Minutes", bookings: "Réservations" };
export const MAIL_KIND: Record<MailKind, string> = { letter: "Lettre", registered: "Recommandé", parcel: "Colis", other: "Autre" };
export const MAIL_STATUS: Record<MailStatus, { label: string; tone: Tone }> = {
  received: { label: "Reçu", tone: "amber" },
  notified: { label: "Client prévenu", tone: "blue" },
  collected: { label: "Remis", tone: "green" },
  returned: { label: "Retourné", tone: "gray" },
};
export const ACCESS_SOURCE: Record<"staff" | "qr", string> = { staff: "Accueil", qr: "QR code" };

export const memberName = (m: { firstName: string; lastName: string | null }) => [m.firstName, m.lastName].filter(Boolean).join(" ");

/** "2 h 30" for a number of minutes. */
export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
}

export const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
export const fromMinutes = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * What cancelling a booking now would cost (rule 11): a request or a booking cancelled before its start minus the
 * free cancellation delay is free; later, the fee is the configured share of the charge.
 */
export function cancellationFee(booking: { status: CwBookingStatus; startsAt: string; charge: number }, settings: Settings, now = new Date()): number {
  const free = booking.status === "requested" || now.getTime() < new Date(booking.startsAt).getTime() - settings.freeCancelHours * 3_600_000;
  return free ? 0 : percentOf(booking.charge, settings.lateCancelFeeBp);
}

/* Shared reads */

export const useSettings = () => useQuery({ queryKey: ["cw-settings"], queryFn: () => api.get<Settings>("/coworking/settings") });
export const useFloors = () => useQuery({ queryKey: ["cw-floors"], queryFn: () => api.get<Floor[]>("/coworking/floors") });
export const useResourceTypes = () => useQuery({ queryKey: ["cw-types"], queryFn: () => api.get<ResourceType[]>("/coworking/resource-types") });
export const useFormats = () => useQuery({ queryKey: ["cw-formats"], queryFn: () => api.get<Format[]>("/coworking/formats") });
export const useFloorDetail = (id: string | null) =>
  useQuery({ queryKey: ["cw-floor", id], queryFn: () => api.get<FloorDetail>(`/coworking/floors/${id}`), enabled: !!id });

/** The plan image of a floor, or null when the floor has none. */
export function floorImage(floor: FloorDetail | undefined): { url: string; width: number; height: number } | null {
  if (!floor?.planMediaId || !floor.planWidth || !floor.planHeight) return null;
  return { url: api.fileUrl(`/media/${floor.planMediaId}/file`), width: floor.planWidth, height: floor.planHeight };
}
