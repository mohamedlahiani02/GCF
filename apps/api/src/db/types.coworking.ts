import type { ColumnType, Generated } from "kysely";
import type { DateColumn, Json, NullableTimestamp, Status, Timestamp } from "./types.js";

/** Columns of type time: "HH:MM:SS" from PostgreSQL, "HH:MM" accepted on write. */
export type TimeColumn = ColumnType<string, string, string>;
type NullableTime = ColumnType<string | null, string | null | undefined, string | null>;

export type CwApprovalMode = "none" | "visitors" | "all";
export type CwSelfSignup = "open" | "validated" | "closed";
export type CwCategory = "hot_desk" | "dedicated_desk" | "private_office" | "meeting_room" | "phone_booth" | "event_space";
export type CwResourceStatus = "active" | "out_of_service" | "archived";
export type CwFormatNature = "fixed" | "named" | "free";
export type CwProfile = "visitor" | "member";
export type CwPeriod = "month" | "quarter" | "year";
export type CwBilling = "upfront" | "monthly";
export type CwQuotaKind = "unlimited" | "minutes" | "bookings";
export type CwBookingStatus = "requested" | "confirmed" | "checked_in" | "completed" | "cancelled" | "refused" | "expired" | "no_show";
export type CwAccessSource = "staff" | "qr";
export type CwMailKind = "letter" | "registered" | "parcel" | "other";
export type CwMailStatus = "received" | "notified" | "collected" | "returned";

export interface CwSettingsTable {
  centre_id: string;
  booking_horizon_days: Generated<number>;
  min_notice_minutes: Generated<number>;
  max_active_bookings: Generated<number>;
  approval_mode: Generated<CwApprovalMode>;
  free_cancel_hours: Generated<number>;
  late_cancel_fee_bp: Generated<number>;
  no_show_grace_minutes: ColumnType<number | null, number | null | undefined, number | null>;
  request_expiry_hours: Generated<number>;
  self_signup: Generated<CwSelfSignup>;
  offpeak_from: NullableTime;
  portal_enabled: Generated<boolean>;
  updated_at: Timestamp;
  updated_by: string | null;
}

export interface CwFloorsTable {
  id: Generated<string>;
  centre_id: string;
  name: string;
  position: Generated<number>;
  plan_media_id: string | null;
  layout: ColumnType<unknown, string | undefined, string>;
  draft_layout: Json;
  layout_published_at: NullableTimestamp;
  layout_published_by: string | null;
  status: Status;
  created_at: Timestamp;
}

export interface CwZonesTable {
  id: Generated<string>;
  centre_id: string;
  floor_id: string;
  name: string;
  color: Generated<string>;
  status: Status;
  created_at: Timestamp;
}

export interface CwAttributesTable {
  id: Generated<string>;
  centre_id: string;
  name: string;
  status: Status;
  created_at: Timestamp;
}

export interface CwResourceTypesTable {
  id: Generated<string>;
  centre_id: string;
  name: string;
  category: CwCategory;
  description: string | null;
  photo_media_id: string | null;
  requires_approval: Generated<boolean>;
  max_minutes_per_day: number | null;
  buffer_minutes: Generated<number>;
  position: Generated<number>;
  public: Generated<boolean>;
  status: Status;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CwResourcesTable {
  id: Generated<string>;
  centre_id: string;
  type_id: string;
  floor_id: string;
  zone_id: string | null;
  code: string;
  name: string | null;
  capacity: Generated<number>;
  room_id: string | null;
  status: Generated<CwResourceStatus>;
  out_of_service_reason: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CwResourceAttributesTable {
  resource_id: string;
  attribute_id: string;
}

export interface CwBookingFormatsTable {
  id: Generated<string>;
  centre_id: string;
  type_id: string;
  label: string;
  nature: CwFormatNature;
  duration_minutes: number | null;
  start_step_minutes: number | null;
  start_time: NullableTime;
  end_time: NullableTime;
  min_minutes: number | null;
  max_minutes: number | null;
  weekdays: Generated<number[]>;
  position: Generated<number>;
  status: Status;
  created_at: Timestamp;
}

export interface CwPricesTable {
  format_id: string;
  profile: CwProfile;
  amount: number;
  offpeak_amount: number | null;
}

export interface CwClosuresTable {
  id: Generated<string>;
  centre_id: string;
  starts_on: DateColumn;
  ends_on: DateColumn;
  label: string;
  open_from: NullableTime;
  open_to: NullableTime;
  created_by: string | null;
  created_at: Timestamp;
}

export interface CwPlansTable {
  id: Generated<string>;
  centre_id: string;
  name: string;
  description: string | null;
  period: CwPeriod;
  price: number;
  billing: CwBilling;
  includes_domiciliation: Generated<boolean>;
  assigned_type_id: string | null;
  notice_days: Generated<number>;
  public: Generated<boolean>;
  position: Generated<number>;
  status: Status;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CwPlanEntitlementsTable {
  plan_id: string;
  type_id: string;
  quota_kind: CwQuotaKind;
  quota: number | null;
}

export interface CwPackProductsTable {
  id: Generated<string>;
  centre_id: string;
  name: string;
  type_id: string;
  quota_kind: Exclude<CwQuotaKind, "unlimited">;
  quota: number;
  validity_days: number;
  price: number;
  public: Generated<boolean>;
  status: Status;
  created_at: Timestamp;
}

export interface CwPromoCodesTable {
  id: Generated<string>;
  centre_id: string;
  code: string;
  kind: "percent" | "amount";
  value: number;
  valid_from: DateColumn;
  valid_to: DateColumn;
  max_uses: number | null;
  profiles: Generated<CwProfile[]>;
  status: Status;
  created_by: string | null;
  created_at: Timestamp;
}

export interface CwSubscriptionsTable {
  id: Generated<string>;
  centre_id: string;
  member_id: string;
  plan_id: string;
  starts_on: DateColumn;
  ends_on: DateColumn;
  price: number;
  billing: CwBilling;
  includes_domiciliation: boolean;
  assigned_resource_id: string | null;
  auto_renew: Generated<boolean>;
  renewed_from_id: string | null;
  status: Generated<"active" | "cancelled">;
  cancelled_at: NullableTimestamp;
  cancelled_by: string | null;
  cancel_reason: string | null;
  created_by: string | null;
  created_at: Timestamp;
}

export interface CwPacksTable {
  id: Generated<string>;
  centre_id: string;
  member_id: string;
  product_id: string;
  type_id: string;
  quota_kind: Exclude<CwQuotaKind, "unlimited">;
  quota: number;
  price: number;
  starts_on: DateColumn;
  expires_on: DateColumn;
  status: Generated<"active" | "cancelled">;
  cancelled_at: NullableTimestamp;
  cancelled_by: string | null;
  cancel_reason: string | null;
  created_by: string | null;
  created_at: Timestamp;
}

export interface CwBookingsTable {
  id: Generated<string>;
  centre_id: string;
  kind: Generated<"booking" | "block">;
  resource_id: string;
  member_id: string | null;
  format_id: string | null;
  starts_at: Date | string;
  ends_at: Date | string;
  blocked_until: Date | string;
  status: CwBookingStatus;
  source: "portal" | "staff";
  profile: CwProfile | null;
  list_price: Generated<number>;
  promo_code_id: string | null;
  promo_discount: Generated<number>;
  covered_minutes: Generated<number>;
  coverage_discount: Generated<number>;
  charge: Generated<number>;
  requested_at: Timestamp;
  decided_at: NullableTimestamp;
  decided_by: string | null;
  refusal_reason: string | null;
  cancelled_at: NullableTimestamp;
  cancelled_by: string | null;
  cancel_reason: string | null;
  late_cancel_fee: Generated<number>;
  checked_in_at: NullableTimestamp;
  check_in_code: Generated<string>;
  notes: string | null;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CwEntitlementUsageTable {
  id: Generated<string>;
  centre_id: string;
  booking_id: string;
  subscription_id: string | null;
  pack_id: string | null;
  quota_kind: CwQuotaKind;
  amount: number;
  window_start: ColumnType<string | null, string | null | undefined, string | null>;
  status: Generated<"active" | "released">;
  created_at: Timestamp;
}

export interface CwAccessEventsTable {
  id: Generated<string>;
  centre_id: string;
  member_id: string;
  booking_id: string | null;
  at: Timestamp;
  source: CwAccessSource;
  recorded_by: string | null;
}

export interface CwMailItemsTable {
  id: Generated<string>;
  centre_id: string;
  member_id: string;
  received_at: Timestamp;
  kind: CwMailKind;
  sender: string | null;
  reference: string | null;
  status: Generated<CwMailStatus>;
  notified_at: NullableTimestamp;
  collected_at: NullableTimestamp;
  collected_by_name: string | null;
  handed_by: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: Timestamp;
}

export interface CoworkingTables {
  cw_settings: CwSettingsTable;
  cw_floors: CwFloorsTable;
  cw_zones: CwZonesTable;
  cw_attributes: CwAttributesTable;
  cw_resource_types: CwResourceTypesTable;
  cw_resources: CwResourcesTable;
  cw_resource_attributes: CwResourceAttributesTable;
  cw_booking_formats: CwBookingFormatsTable;
  cw_prices: CwPricesTable;
  cw_closures: CwClosuresTable;
  cw_plans: CwPlansTable;
  cw_plan_entitlements: CwPlanEntitlementsTable;
  cw_pack_products: CwPackProductsTable;
  cw_promo_codes: CwPromoCodesTable;
  cw_subscriptions: CwSubscriptionsTable;
  cw_packs: CwPacksTable;
  cw_bookings: CwBookingsTable;
  cw_entitlement_usage: CwEntitlementUsageTable;
  cw_access_events: CwAccessEventsTable;
  cw_mail_items: CwMailItemsTable;
}
