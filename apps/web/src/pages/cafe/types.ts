export type CafeMethod = "cash" | "card";
export const CAFE_METHOD: Record<CafeMethod, string> = { cash: "Espèces", card: "Carte" };

export interface CafeProduct {
  id: string;
  name: string;
  category: string | null;
  price: number;
  trackStock: boolean;
  stockQuantity: number;
  lowStockThreshold: number | null;
  active: boolean;
}
export interface CafeSettings {
  openingFloat: number;
  allowNegativeStock: boolean;
  ticketPrefix: string;
}
export interface CafeSaleLine {
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}
export interface CafeTicket {
  id: string;
  number: string;
  soldAt: string;
  method: CafeMethod;
  total: number;
  cashReceived: number | null;
  change: number | null;
  lines: CafeSaleLine[];
}

export const isLow = (p: CafeProduct) => p.trackStock && p.lowStockThreshold !== null && p.stockQuantity <= p.lowStockThreshold;
