import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api } from "../../api/client";
import { usePage } from "../../components/shell";
import { Card, Empty, ErrorBanner, Kpi, Loading, PageHeader, StateBadge } from "../../components/ui";
import { frDate, frDateTime, tnd } from "../../lib/format";
import { ACCESS_SOURCE, CATEGORY, QUOTA, durationLabel, type Booking, type BookingDetail } from "./api";
import { BlockPanel, BookingActions, BookingFacts, BookingStatusBadge, useMemberCollect } from "./bookingParts";

/** Steps of a booking's life, in order, from the fields the booking keeps. */
function history(b: Booking): { at: string; label: string; detail?: string }[] {
  const steps: { at: string; label: string; detail?: string }[] = [
    { at: b.requestedAt, label: b.source === "portal" ? "Demandée depuis l'espace client" : "Enregistrée à l'accueil" },
  ];
  if (b.decidedAt) {
    steps.push(
      b.status === "refused"
        ? { at: b.decidedAt, label: "Demande refusée", ...(b.refusalReason ? { detail: b.refusalReason } : {}) }
        : { at: b.decidedAt, label: "Demande acceptée" },
    );
  }
  if (b.checkedInAt) steps.push({ at: b.checkedInAt, label: "Arrivée du client" });
  if (b.cancelledAt) {
    steps.push({
      at: b.cancelledAt,
      label: b.lateCancelFee > 0 ? `Annulée, frais de ${tnd(b.lateCancelFee)} TND` : "Annulée",
      ...(b.cancelReason ? { detail: b.cancelReason } : {}),
    });
  }
  return steps.sort((x, y) => x.at.localeCompare(y.at));
}

/** One booking: facts, status history, charges with what was paid, entitlements used, access events and actions. */
export function BookingPage() {
  const { id = "" } = useParams();
  const collect = useMemberCollect();
  const detail = useQuery({ queryKey: ["cw-booking", id], queryFn: () => api.get<BookingDetail>(`/coworking/bookings/${id}`) });
  const b = detail.data;
  usePage(["Coworking", b ? `Réservation ${b.resourceCode}` : "Réservation"]);
  if (detail.isPending) return <Loading />;
  if (detail.error || !b) return <ErrorBanner error={detail.error} retry={() => detail.refetch()} />;
  const title = `${b.kind === "block" ? "Blocage" : "Réservation"} ${CATEGORY[b.category]} ${b.resourceCode}`;

  if (b.kind === "block") {
    return (
      <>
        <PageHeader title={title} subtitle={`${frDateTime(b.startsAt)} au ${frDateTime(b.endsAt)}`} />
        <Card title="Blocage">
          <div className="card-b">
            <BlockPanel block={b} />
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={title}
        subtitle={
          <span className="row center" style={{ gap: 8 }}>
            <BookingStatusBadge status={b.status} />
            <span>
              {frDate(b.localDate)} {b.startTime}-{b.endTime}
            </span>
            {b.memberId ? <Link to={`/coworking/membres/${b.memberId}`}>{b.memberName}</Link> : null}
          </span>
        }
      />
      <div className="grid4">
        <Kpi label="Montant" value={<span className="num">{tnd(b.charge)}</span>} sub={`TND, tarif ${tnd(b.listPrice)}`} />
        <Kpi label="Réglé" value={<span className="num">{tnd(b.paid)}</span>} sub="TND" />
        <Kpi label="Reste à payer" value={<span className="num">{tnd(b.due)}</span>} sub="TND" tone={b.due > 0 && b.charges.some((c) => c.state === "overdue") ? "red" : undefined} />
        <Kpi label="Couvert par les droits" value={durationLabel(b.coveredMinutes)} sub={b.coverageDiscount ? `${tnd(b.coverageDiscount)} TND déduits` : "aucune déduction"} />
      </div>
      <Card title="Actions">
        <div className="card-b">
          <BookingActions booking={b} due={b.due} onCollect={(memberId) => collect.open(memberId)} />
        </div>
      </Card>
      <div className="grid2" style={{ alignItems: "start" }}>
        <Card title="Détails">
          <BookingFacts booking={b} paid={b.paid} due={b.due} />
        </Card>
        <Card title="Historique">
          <div className="card-b">
            <ol className="tl">
              {history(b).map((h, i) => (
                <li key={i}>
                  <div className="cap">{frDateTime(h.at)}</div>
                  <div>{h.label}</div>
                  {h.detail ? <div className="cap">{h.detail}</div> : null}
                </li>
              ))}
            </ol>
          </div>
        </Card>
      </div>
      <div className="grid2" style={{ alignItems: "start" }}>
        <Card title="Échéances">
          {b.charges.length === 0 ? (
            <Empty title="Aucune échéance" text={b.status === "requested" ? "L'échéance est créée à l'acceptation." : "Rien à payer pour cette réservation."} />
          ) : (
            <div className="xs">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Échéance</th>
                    <th>Statut</th>
                    <th className="num">Montant</th>
                    <th className="num">Payé</th>
                    <th className="num">Reste</th>
                  </tr>
                </thead>
                <tbody>
                  {b.charges.map((c) => (
                    <tr key={c.id}>
                      <td>
                        {frDate(c.dueDate)}
                        <div className="cap">{c.label}</div>
                      </td>
                      <td>
                        <StateBadge state={c.state} />
                      </td>
                      <td className="num">{tnd(c.amount)}</td>
                      <td className="num">{tnd(c.paid)}</td>
                      <td className="num">{c.status === "open" ? tnd(c.remaining) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Droits utilisés">
          {b.usage.length === 0 ? (
            <Empty title="Aucun droit utilisé" />
          ) : (
            <div className="xs">
              <table className="tbl">
                <tbody>
                  {b.usage.map((u) => (
                    <tr key={u.id} className={u.status === "released" ? "void" : ""}>
                      <td>
                        {u.subscriptionId ? "Abonnement" : "Carnet"} {u.label}
                        <div className="cap">
                          {QUOTA[u.quotaKind]}
                          {u.windowStart ? `, mois du ${frDate(u.windowStart)}` : ""}
                          {u.status === "released" ? ", rendu" : ""}
                        </div>
                      </td>
                      <td className="num">{u.quotaKind === "minutes" ? durationLabel(u.amount) : u.quotaKind === "bookings" ? `${u.amount} réservation` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      <Card title="Accès">
        {b.accessEvents.length === 0 ? (
          <Empty title="Aucune entrée enregistrée" />
        ) : (
          <div className="xs">
            <table className="tbl">
              <tbody>
                {b.accessEvents.map((e) => (
                  <tr key={e.id}>
                    <td>{frDateTime(e.at)}</td>
                    <td>{ACCESS_SOURCE[e.source]}</td>
                    <td>{e.recordedBy ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {collect.element}
    </>
  );
}
