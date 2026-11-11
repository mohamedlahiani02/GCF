import type { ColumnType, Generated } from "kysely";
import type { DateColumn, Json, OptionalRef, Timestamp } from "./types.js";

export type CafeSaleMethod = "cash" | "card";
export type CafeStockMovementKind = "purchase" | "sale" | "sale_cancelled" | "loss" | "count";

export type CafeTicketPrinting = "none" | "browser" | "thermal_58" | "thermal_80";
export type CafePurchasing = "simple" | "suppliers" | "orders";
export type CafeOrderStatus = "draft" | "ordered" | "received" | "cancelled";
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

export interface CafeSettingsTable {
  centre_id: string;
  opening_float: Generated<number>;
  allow_negative_stock: Generated<boolean>;
  ticket_prefix: Generated<string>;
  ticket_printing: Generated<CafeTicketPrinting>;
  purchasing: Generated<CafePurchasing>;
  updated_by: OptionalRef;
  updated_at: Timestamp;
}

export interface CafeProductsTable {
  id: Generated<string>;
  centre_id: string;
  name: string;
  category: string | null;
  price: number;
  track_stock: Generated<boolean>;
  stock_quantity: Generated<number>;
  low_stock_threshold: number | null;
  active: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CafeSaleCountersTable {
  centre_id: string;
  year: number;
  last_number: number;
}

export interface CafeSalesTable {
  id: Generated<string>;
  centre_id: string;
  number: string;
  day: DateColumn;
  sold_at: Timestamp;
  method: CafeSaleMethod;
  total: number;
  cash_received: number | null;
  status: Generated<"valid" | "cancelled">;
  cancelled_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  cancelled_by: OptionalRef;
  cancel_reason: string | null;
  created_by: string;
}

export interface CafeSaleLinesTable {
  id: Generated<string>;
  sale_id: string;
  centre_id: string;
  product_id: string;
  product_name: string;
  unit_price: number;
  quantity: number;
  line_total: number;
}

export interface CafeStockMovementsTable {
  id: Generated<string>;
  centre_id: string;
  product_id: string;
  kind: CafeStockMovementKind;
  quantity: number;
  quantity_after: number;
  unit_cost: number | null;
  reason: string | null;
  sale_id: string | null;
  supplier_id: string | null;
  purchase_order_id: string | null;
  created_by: string;
  created_at: Timestamp;
}

export interface CafeSuppliersTable {
  id: Generated<string>;
  centre_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  note: string | null;
  active: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CafePurchaseOrdersTable {
  id: Generated<string>;
  centre_id: string;
  number: string;
  supplier_id: string;
  status: Generated<CafeOrderStatus>;
  note: string | null;
  total: number;
  created_by: string;
  created_at: Timestamp;
  ordered_at: NullableTimestamp;
  received_at: NullableTimestamp;
  received_by: OptionalRef;
  cancelled_at: NullableTimestamp;
  cancel_reason: string | null;
}

export interface CafePurchaseOrderLinesTable {
  id: Generated<string>;
  order_id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_cost: number;
}

export interface CafeClosingsTable {
  id: Generated<string>;
  centre_id: string;
  day: DateColumn;
  opening_float: number;
  expected_cash: number;
  counted_cash: number;
  difference: number;
  comment: string | null;
  totals: Json;
  closed_by: string;
  closed_at: Timestamp;
}

export interface CafeTables {
  cafe_settings: CafeSettingsTable;
  cafe_products: CafeProductsTable;
  cafe_sale_counters: CafeSaleCountersTable;
  cafe_sales: CafeSalesTable;
  cafe_sale_lines: CafeSaleLinesTable;
  cafe_stock_movements: CafeStockMovementsTable;
  cafe_closings: CafeClosingsTable;
  cafe_suppliers: CafeSuppliersTable;
  cafe_order_counters: CafeSaleCountersTable;
  cafe_purchase_orders: CafePurchaseOrdersTable;
  cafe_purchase_order_lines: CafePurchaseOrderLinesTable;
}
