import type { CwCategory, FloorLayout } from "@gcf/shared";

/** Shapes returned by /api/coworking configuration routes (apps/api/src/routes/coworking/config.ts). */

export type ArchiveStatus = "active" | "archived";

export interface CwSettings {
  bookingHorizonDays: number;
  minNoticeMinutes: number;
  maxActiveBookings: number;
  approvalMode: "none" | "visitors" | "all";
  freeCancelHours: number;
  lateCancelFeeBp: number;
  noShowGraceMinutes: number | null;
  requestExpiryHours: number;
  selfSignup: "open" | "validated" | "closed";
  offpeakFrom: string | null;
  portalEnabled: boolean;
  updatedAt: string;
}

export interface FloorRow {
  id: string;
  name: string;
  position: number;
  status: ArchiveStatus;
  planMediaId: string | null;
  layoutPublishedAt: string | null;
  hasDraft: boolean;
  resourceCount: number;
}

export interface FloorResource {
  id: string;
  code: string;
  name: string | null;
  typeId: string;
  typeName: string;
  category: CwCategory;
  zoneId: string | null;
  capacity: number;
  status: "active" | "out_of_service";
}

export interface Zone {
  id: string;
  floorId: string;
  name: string;
  color: string;
  status: ArchiveStatus;
}

export interface FloorDetail {
  id: string;
  name: string;
  position: number;
  status: ArchiveStatus;
  planMediaId: string | null;
  layoutPublishedAt: string | null;
  layoutPublishedBy: string | null;
  planWidth: number | null;
  planHeight: number | null;
  layout: FloorLayout;
  draftLayout: FloorLayout | null;
  zones: Zone[];
  resources: FloorResource[];
}

export interface Attribute {
  id: string;
  name: string;
  status: ArchiveStatus;
}

export interface ResourceType {
  id: string;
  name: string;
  category: CwCategory;
  description: string | null;
  photoMediaId: string | null;
  requiresApproval: boolean;
  maxMinutesPerDay: number | null;
  bufferMinutes: number;
  position: number;
  public: boolean;
  status: ArchiveStatus;
  resourceCount: number;
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
  zoneId: string | null;
  zoneName: string | null;
  capacity: number;
  roomId: string | null;
  roomName: string | null;
  status: "active" | "out_of_service" | "archived";
  outOfServiceReason: string | null;
  attributeIds: string[];
}

export type FormatNature = "fixed" | "named" | "free";
export type Profile = "visitor" | "member";

export interface Price {
  profile: Profile;
  amount: number;
  offpeakAmount: number | null;
}

export interface BookingFormat {
  id: string;
  typeId: string;
  label: string;
  nature: FormatNature;
  durationMinutes: number | null;
  startStepMinutes: number | null;
  startTime: string | null;
  endTime: string | null;
  minMinutes: number | null;
  maxMinutes: number | null;
  weekdays: number[];
  position: number;
  status: ArchiveStatus;
  prices: Price[];
}

export interface Closure {
  id: string;
  startsOn: string;
  endsOn: string;
  label: string;
  openFrom: string | null;
  openTo: string | null;
}

export type QuotaKind = "unlimited" | "minutes" | "bookings";

export interface Entitlement {
  typeId: string;
  typeName: string;
  quotaKind: QuotaKind;
  quota: number | null;
}

export interface Plan {
  id: string;
  name: string;
  description: string | null;
  period: "month" | "quarter" | "year";
  price: number;
  billing: "upfront" | "monthly";
  includesDomiciliation: boolean;
  assignedTypeId: string | null;
  noticeDays: number;
  public: boolean;
  position: number;
  status: ArchiveStatus;
  subscriptionCount: number;
  entitlements: Entitlement[];
}

export interface PackProduct {
  id: string;
  name: string;
  typeId: string;
  quotaKind: "minutes" | "bookings";
  quota: number;
  validityDays: number;
  price: number;
  public: boolean;
  status: ArchiveStatus;
}

export interface PromoCode {
  id: string;
  code: string;
  kind: "percent" | "amount";
  value: number;
  validFrom: string;
  validTo: string;
  maxUses: number | null;
  profiles: Profile[];
  status: ArchiveStatus;
  uses: number;
}

export interface MediaFile {
  id: string;
  width: number;
  height: number;
}

/** Query keys of the configuration screens; every key starts with "cw-config" so a change can refresh them together. */
export const CW_KEYS = {
  all: ["cw-config"] as const,
  settings: ["cw-config", "settings"] as const,
  floors: ["cw-config", "floors"] as const,
  floor: (id: string) => ["cw-config", "floor", id] as const,
  zones: ["cw-config", "zones"] as const,
  attributes: ["cw-config", "attributes"] as const,
  types: ["cw-config", "types"] as const,
  resources: ["cw-config", "resources"] as const,
  formats: ["cw-config", "formats"] as const,
  closures: ["cw-config", "closures"] as const,
  plans: ["cw-config", "plans"] as const,
  packs: ["cw-config", "packs"] as const,
  promos: ["cw-config", "promos"] as const,
};
