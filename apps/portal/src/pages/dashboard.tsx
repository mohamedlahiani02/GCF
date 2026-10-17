import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../api/client";
import type { Account, Booking, Pack, Page, Subscription } from "../api/types";
import { useMember } from "../auth/session";
import { BookingList } from "./bookings";
import { Card, Empty, ErrorBanner, Kpi, Loading, Money, PageHeader } from "../components/ui";
import { useI18n } from "../i18n/i18n";
import { useFormat } from "../lib/format";
import { quotaText } from "./subscription";

const UPCOMING_SHOWN = 5;

export function DashboardPage() {
  const member = useMember();
  const { t, language } = useI18n();
  const f = useFormat();
  const upcoming = useQuery({
    queryKey: ["bookings", "upcoming", 1, UPCOMING_SHOWN],
    queryFn: () => api.get<Page<Booking>>("/bookings", { scope: "upcoming", page: 1, pageSize: UPCOMING_SHOWN }),
  });
  const subscription = useQuery({ queryKey: ["subscription"], queryFn: () => api.get<{ items: Subscription[] }>("/subscription") });
  const packs = useQuery({ queryKey: ["packs"], queryFn: () => api.get<{ items: Pack[] }>("/packs") });
  const account = useQuery({ queryKey: ["account"], queryFn: () => api.get<Account>("/account") });
  const current = subscription.data?.items.find((s) => s.state === "current");
  const activePacks = packs.data?.items.filter((p) => p.state === "active") ?? [];
  return (
    <>
      <PageHeader
        title={t.dashboard.hello(member.firstName)}
        actions={
          <Link to="/reserver" className="btn btn-p btn-l">
            {t.nav.book}
          </Link>
        }
      />
      <div className="grid2 portal-grid">
        <Kpi
          label={t.dashboard.due}
          value={account.data ? <Money value={account.data.totals.due} /> : "-"}
          sub={account.data && account.data.totals.due > 0 ? t.common.payAtDesk : undefined}
        />
        <Kpi label={t.dashboard.credit} value={account.data ? <Money value={account.data.totals.credit} /> : "-"} />
      </div>
      <ErrorBanner error={account.error} />
      <Card
        title={t.dashboard.upcoming}
        actions={
          <Link to="/reservations" className="btn btn-g">
            {t.dashboard.seeAll}
          </Link>
        }
      >
        <ErrorBanner error={upcoming.error} retry={() => upcoming.refetch()} />
        {upcoming.isPending ? (
          <Loading />
        ) : upcoming.data?.items.length ? (
          <BookingList items={upcoming.data.items} />
        ) : (
          <Empty title={t.dashboard.noUpcoming} />
        )}
      </Card>
      <div className="grid2 portal-grid">
        <Card
          title={t.dashboard.subscription}
          actions={
            <Link to="/abonnement" className="btn btn-g">
              {t.dashboard.seeAll}
            </Link>
          }
        >
          <div className="card-b stack">
            <ErrorBanner error={subscription.error} />
            {current ? (
              <>
                <strong>{current.planName}</strong>
                <span className="cap">{t.subscription.period(f.date(current.startsOn), f.date(current.endsOn))}</span>
                {current.entitlements.map((e) => (
                  <span key={e.typeId}>
                    {t.common.pair(
                      e.typeName ?? "",
                      e.remaining === null ? t.subscription.unlimited : t.dashboard.remaining(quotaText(e.quotaKind, e.remaining, language)),
                    )}
                  </span>
                ))}
              </>
            ) : subscription.isPending ? null : (
              <span className="cap">{t.dashboard.noSubscription}</span>
            )}
          </div>
        </Card>
        <Card
          title={t.dashboard.packs}
          actions={
            <Link to="/packs" className="btn btn-g">
              {t.dashboard.seeAll}
            </Link>
          }
        >
          <div className="card-b stack">
            <ErrorBanner error={packs.error} />
            {activePacks.length ? (
              activePacks.map((p) => (
                <span key={p.id}>
                  {t.common.pair(
                    `${p.productName} (${p.typeName})`,
                    `${t.dashboard.remaining(quotaText(p.quotaKind, p.remaining, language))}, ${t.dashboard.until(f.date(p.expiresOn))}`,
                  )}
                </span>
              ))
            ) : packs.isPending ? null : (
              <span className="cap">{t.dashboard.noPacks}</span>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
