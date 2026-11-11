import type { ColumnType, Generated } from "kysely";
import type { DateColumn, Json, OptionalRef, Timestamp } from "./types.js";

export type CafeSaleMethod = "cash" | "card";
export type CafeStockMovementKind = "purchase" | "sale" | "sale_cancelled" | "loss" | "count";

export interface CafeSettingsTable {
  centre_id: string;
  opening_float: Generated<number>;
  allow_negative_stock: Generated<boolean>;
  ticket_prefix: Generated<string>;
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
  created_by: string;
  created_at: Timestamp;
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
}
