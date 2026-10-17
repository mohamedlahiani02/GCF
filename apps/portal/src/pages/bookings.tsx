import { CW_CATEGORY_LABELS } from "@gcf/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import type { Booking, Page } from "../api/types";
import { BookingStatusBadge } from "../components/badges";
import { Card, Empty, ErrorBanner, Loading, Money, PageHeader, Pagination, Tabs } from "../components/ui";
import { useI18n } from "../i18n/i18n";
import { useFormat } from "../lib/format";

const PAGE_SIZE = 20;

/** What the booking costs the member now: nothing once refused or expired, only the late fee once cancelled. */
export function amountOf(b: Pick<Booking, "status" | "charge" | "lateCancelFee">): number {
  if (b.status === "cancelled") return b.lateCancelFee;
  if (b.status === "refused" || b.status === "expired") return 0;
  return b.charge;
}

/** Bookings as a table whose rows open the booking. */
export function BookingList({ items }: { items: Booking[] }) {
  const { t, language } = useI18n();
  const f = useFormat();
  return (
    <div className="xs">
      <table className="tbl">
        <thead>
          <tr>
            <th>{t.bookings.date}</th>
            <th>{t.bookings.time}</th>
            <th>{t.bookings.space}</th>
            <th>{t.bookings.status}</th>
            <th className="num">{t.bookings.amount}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((b) => (
            <tr key={b.id}>
              <td>
                <Link to={`/reservations/${b.id}`} aria-label={`${t.bookings.open} ${t.detail.title(b.resourceCode)}, ${f.date(b.date)}`}>
                  {f.date(b.date, true)}
                </Link>
              </td>
              <td className="num" style={{ textAlign: "start" }}>
                {b.startTime} - {b.endTime}
              </td>
              <td>
                {CW_CATEGORY_LABELS[language][b.category]} {b.resourceCode}
                <div className="cap">{b.typeName}</div>
              </td>
              <td>
                <BookingStatusBadge status={b.status} />
              </td>
              <td className="num">
                <Money value={amountOf(b)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BookingsPage() {
  const { t } = useI18n();
  const [scope, setScope] = useState<"upcoming" | "past">("upcoming");
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ["bookings", scope, page, PAGE_SIZE],
    queryFn: () => api.get<Page<Booking>>("/bookings", { scope, page, pageSize: PAGE_SIZE }),
  });
  return (
    <>
      <PageHeader
        title={t.bookings.title}
        actions={
          <Link to="/reserver" className="btn btn-p">
            {t.bookings.newBooking}
          </Link>
        }
      />
      <Card
        footer={
          query.data && (page > 1 || query.data.hasMore) ? <Pagination page={page} hasMore={query.data.hasMore} onPage={setPage} /> : undefined
        }
      >
        <Tabs
          value={scope}
          tabs={[
            { value: "upcoming", label: t.bookings.upcoming },
            { value: "past", label: t.bookings.past },
          ]}
          onChange={(next) => {
            setScope(next);
            setPage(1);
          }}
        />
        <ErrorBanner error={query.error} retry={() => query.refetch()} />
        {query.isPending ? (
          <Loading />
        ) : query.data?.items.length ? (
          <BookingList items={query.data.items} />
        ) : (
          <Empty title={scope === "upcoming" ? t.bookings.noUpcoming : t.bookings.noPast} />
        )}
      </Card>
    </>
  );
}
