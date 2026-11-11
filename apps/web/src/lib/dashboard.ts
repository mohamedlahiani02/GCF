export type Granularity = "day" | "week" | "month";
export interface Dashboard {
  today: string;
  sections: { financial: boolean; operational: boolean };
  financial?: {
    collectionsToday: number;
    collectionsMonth: number;
    /** The café share of the two totals above; its till is separate. */
    cafeToday: number;
    cafeMonth: number;
    unpaidTotal: number;
    unpaidPayers: number;
    postponedInstallments: number;
    payroll: { toValidate: number; toPay: number };
    series: { bucket: string; total: number }[];
  };
  operational?: {
    attendanceRateBasisPoints: number | null;
    roomOccupancyBasisPoints: number | null;
    todo: {
      sessionsWithoutSheet: { id: string; groupName: string; startsAt: string }[];
      overdueInstallments: { count: number; total: number };
      remindersToSend: number;
      unclosedCashDays: string[];
    };
    agenda: {
      type: "session" | "rental";
      id: string;
      startsAt: string;
      endsAt: string;
      label: string;
      instructorName: string | null;
      roomName: string | null;
      sheetStatus: string | null;
    }[];
  };
}
