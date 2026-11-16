import { useMutation } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, useParams } from "react-router";
import { api, ApiError } from "../api/client";
import type { BookingDetail } from "../api/types";
import { Card, ErrorBanner, Notice, PageHeader, Spinner } from "../components/ui";
import { useI18n } from "../i18n/i18n";

/** Opened by scanning the QR code stuck on a place: records the arrival of the signed-in member on it. */
export function ArrivalPage() {
  const { t } = useI18n();
  const { token = "" } = useParams();
  const arrive = useMutation({ mutationFn: () => api.post<BookingDetail>(`/checkin/${token}`, {}) });
  const { mutate } = arrive;
  // The arrival is recorded once, when the page opens.
  useEffect(() => mutate(), [mutate, token]);
  const notFound = arrive.error instanceof ApiError && arrive.error.status === 404;
  return (
    <>
      <PageHeader title={t.arrival.title} />
      <Card>
        {arrive.isPending ? (
          <p>
            <Spinner /> {t.arrival.working}
          </p>
        ) : arrive.isSuccess ? (
          <Notice tone="green">{t.arrival.done}</Notice>
        ) : notFound ? (
          <Notice tone="amber">{t.arrival.none}</Notice>
        ) : (
          <ErrorBanner error={arrive.error} />
        )}
        <p>
          <Link to="/reservations">{t.arrival.see}</Link>
        </p>
      </Card>
    </>
  );
}
