import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Pack, QuotaKind, Subscription } from "../api/types";
import { Badge, Card, Empty, ErrorBanner, fact, Facts, Loading, Money, PageHeader } from "../components/ui";
import { DICTIONARIES } from "../i18n/dictionary";
import { useI18n, type Language } from "../i18n/i18n";
import { minutesText, useFormat } from "../lib/format";

/** A quantity of an entitlement or a pack: minutes as a duration, bookings as a count. */
export function quotaText(kind: QuotaKind, amount: number | null, language: Language): string {
  const t = DICTIONARIES[language];
  if (kind === "unlimited" || amount === null) return t.subscription.unlimited;
  return kind === "minutes" ? minutesText(amount, language) : t.subscription.bookings(amount);
}

function SubscriptionCard({ subscription: s }: { subscription: Subscription }) {
  const { t, language } = useI18n();
  const f = useFormat();
  return (
    <Card
      title={
        <div className="row center" style={{ gap: 8 }}>
          <h2 className="h2">{s.planName}</h2>
          <Badge tone={s.state === "current" ? "green" : "blue"}>{s.state === "current" ? t.subscription.current : t.subscription.upcoming}</Badge>
        </div>
      }
    >
      <div className="card-b stack">
        <Facts
          items={[
            [t.subscription.dates, t.subscription.period(f.date(s.startsOn), f.date(s.endsOn))],
            [t.subscription.price, <Money value={s.price} />],
            [t.subscription.billing, s.billing === "upfront" ? t.subscription.upfront : t.subscription.monthly],
            [t.subscription.domiciliation, s.includesDomiciliation ? t.common.yes : t.common.no],
            ...fact(s.assignedResourceCode, t.subscription.assigned, s.assignedResourceCode),
            [t.subscription.autoRenew, s.autoRenew ? t.common.yes : t.common.no],
            [t.subscription.window, t.subscription.period(f.date(s.window.start), f.date(s.window.end))],
          ]}
        />
        <h3 className="h3">{t.subscription.entitlements}</h3>
        {s.entitlements.length ? (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t.subscription.space}</th>
                  <th className="num">{t.subscription.quota}</th>
                  <th className="num">{t.subscription.used}</th>
                  <th className="num">{t.subscription.remaining}</th>
                </tr>
              </thead>
              <tbody>
                {s.entitlements.map((e) => (
                  <tr key={e.typeId}>
                    <td>{e.typeName}</td>
                    <td className="num">{quotaText(e.quotaKind, e.quota, language)}</td>
                    <td className="num">{e.used === null ? "-" : quotaText(e.quotaKind, e.used, language)}</td>
                    <td className="num">{quotaText(e.quotaKind, e.remaining, language)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <span className="cap">{t.subscription.noEntitlements}</span>
        )}
      </div>
    </Card>
  );
}

export function SubscriptionPage() {
  const { t } = useI18n();
  const query = useQuery({ queryKey: ["subscription"], queryFn: () => api.get<{ items: Subscription[] }>("/subscription") });
  return (
    <>
      <PageHeader title={t.subscription.title} />
      <ErrorBanner error={query.error} retry={() => query.refetch()} />
      {query.isPending ? (
        <Loading />
      ) : query.data?.items.length ? (
        query.data.items.map((s) => <SubscriptionCard key={s.id} subscription={s} />)
      ) : (
        <Card>
          <Empty title={t.subscription.none} />
        </Card>
      )}
    </>
  );
}

const PACK_TONE: Record<Pack["state"], "green" | "gray" | "amber"> = { active: "green", used_up: "amber", expired: "gray", cancelled: "gray" };

export function PacksPage() {
  const { t, language } = useI18n();
  const f = useFormat();
  const query = useQuery({ queryKey: ["packs"], queryFn: () => api.get<{ items: Pack[] }>("/packs") });
  return (
    <>
      <PageHeader title={t.packs.title} />
      <ErrorBanner error={query.error} retry={() => query.refetch()} />
      {query.isPending ? (
        <Loading />
      ) : (
        <Card>
          {query.data?.items.length ? (
            <div className="xs">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t.packs.pack}</th>
                    <th>{t.packs.space}</th>
                    <th className="num">{t.packs.quota}</th>
                    <th className="num">{t.packs.used}</th>
                    <th className="num">{t.packs.remaining}</th>
                    <th>{t.packs.validity}</th>
                    <th className="num">{t.packs.price}</th>
                    <th>{t.packs.state}</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((p) => (
                    <tr key={p.id}>
                      <td>{p.productName}</td>
                      <td>{p.typeName}</td>
                      <td className="num">{quotaText(p.quotaKind, p.quota, language)}</td>
                      <td className="num">{quotaText(p.quotaKind, p.used, language)}</td>
                      <td className="num">{quotaText(p.quotaKind, p.remaining, language)}</td>
                      <td>{t.subscription.period(f.date(p.startsOn), f.date(p.expiresOn))}</td>
                      <td className="num">
                        <Money value={p.price} />
                      </td>
                      <td>
                        <Badge tone={PACK_TONE[p.state]}>{t.packs.states[p.state]}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title={t.packs.none} />
          )}
        </Card>
      )}
    </>
  );
}
