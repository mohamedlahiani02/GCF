import type { CwBookingStatus } from "@gcf/shared";
import type { InstallmentState } from "../api/types";
import { useI18n } from "../i18n/i18n";
import { Badge, type Tone } from "./ui";

/** Same colours as the back-office badges. */
const BOOKING_TONE: Record<CwBookingStatus, Tone> = {
  requested: "amber",
  confirmed: "blue",
  checked_in: "violet",
  completed: "green",
  cancelled: "gray",
  refused: "red",
  expired: "gray",
  no_show: "red",
};

const INSTALLMENT_TONE: Record<InstallmentState, Tone> = {
  paid: "green",
  partial: "amber",
  overdue: "red",
  postponed: "violet",
  upcoming: "neutral",
  cancelled: "gray",
  pending_discount: "amber",
  discount: "green",
  rejected_discount: "gray",
};

export function BookingStatusBadge({ status }: { status: CwBookingStatus }) {
  const { t } = useI18n();
  return <Badge tone={BOOKING_TONE[status]}>{t.status[status]}</Badge>;
}

export function InstallmentBadge({ state }: { state: InstallmentState }) {
  const { t } = useI18n();
  return (
    <Badge tone={INSTALLMENT_TONE[state]} strike={state === "cancelled" || state === "rejected_discount"}>
      {t.installmentState[state]}
    </Badge>
  );
}
