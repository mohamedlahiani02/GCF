import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../../api/client";
import { usePage } from "../../components/shell";
import { Bar, Card, Empty, ErrorBanner, Kpi, Loading, PageHeader, rateTone } from "../../components/ui";
import { percent, tnd, todayIso, weekdayLabel } from "../../lib/format";
import { CATEGORY, durationLabel } from "./api";
import type { CwCategory } from "@gcf/shared";

interface Indicators {
  bookings: number;
  noShows: number;
  noShowRate: number;
  lateCancellations: number;
  lateCancellationRate: number;
  averageMinutes: number;
  averageLeadMinutes: number;
  activeSubscriptions: number;
  monthlyRecurringRevenue: number;
  convertedGuests: number;
}
interface Occupancy {
  openMinutes: number;
  resources: {
    resourceId: string;
    code: string;
    typeName: string;
    category: CwCategory;
    bookedMinutes: number;
    usedMinutes: number;
    bookedRate: number;
    usedRate: number;
  }[];
}
interface Heatmap {
  types: {
    typeId: string;
    typeName: string;
    resources: number;
    cells: { weekday: number; hour: number; bookedMinutes: number; capacityMinutes: number; rate: number }[];
  }[];
}
interface Revenue {
  lines: { source: "bookings" | "subscriptions" | "packs"; typeId: string | null; typeName: string | null; issued: number; collected: number }[];
}
interface TopMembers {
  items: { memberId: string; name: string; company: string | null; collected: number }[];
}

const SOURCE: Record<Revenue["lines"][number]["source"], string> = { bookings: "Réservations", packs: "Carnets", subscriptions: "Abonnements" };

/** One statistics endpoint for a period of local dates. */
function statsQuery<T>(path: string, from: string, to: string, enabled: boolean) {
  return { queryKey: ["cw-stats", path, from, to], queryFn: () => api.get<T>(`/coworking/stats/${path}`, { from, to }), enabled };
}

/** "3 j 4 h" for a lead time in minutes. */
function leadLabel(minutes: number): string {
  if (minutes < 24 * 60) return durationLabel(minutes);
  const days = Math.floor(minutes / 1440);
  const hours = Math.round((minutes % 1440) / 60);
  return hours ? `${days} j ${hours} h` : `${days} j`;
}

/** Booked share of one weekday and hour, as an accessible table cell shaded by the rate. */
function HeatCell({ rate, booked }: { rate: number | undefined; booked: number }) {
  if (rate === undefined) return <td className="cw-heat-cell cw-heat-closed" aria-label="Fermé" />;
  return (
    <td
      className="cw-heat-cell num"
      style={{ background: `rgba(14, 90, 138, ${(0.08 + 0.85 * (rate / 10_000)).toFixed(2)})`, color: rate > 5_500 ? "#fff" : undefined }}
      title={`${durationLabel(booked)} réservées`}
    >
      {Math.round(rate / 100)}
    </td>
  );
}

function HeatTable({ type }: { type: Heatmap["types"][number] }) {
  const weekdays = [...new Set(type.cells.map((c) => c.weekday))].sort();
  const hours = [...new Set(type.cells.map((c) => c.hour))].sort((a, b) => a - b);
  const cell = new Map(type.cells.map((c) => [`${c.weekday}:${c.hour}`, c]));
  return (
    <div className="xs">
      <table className="tbl cw-heat">
        <caption className="visually-hidden">Taux de réservation en pour cent de {type.typeName} par jour et par heure</caption>
        <thead>
          <tr>
            <th scope="col">Jour</th>
            {hours.map((h) => (
              <th key={h} scope="col" className="num">
                {h}h
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weekdays.map((d) => (
            <tr key={d}>
              <th scope="row">{weekdayLabel(d)}</th>
              {hours.map((h) => {
                const c = cell.get(`${d}:${h}`);
                return <HeatCell key={h} rate={c?.rate} booked={c?.bookedMinutes ?? 0} />;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Coworking statistics of a period: indicators, occupancy per resource, weekday and hour heat maps, revenue, top members. */
export function StatsPage() {
  usePage(["Coworking", "Statistiques"]);
  const [from, setFrom] = useState(todayIso().slice(0, 8) + "01");
  const [to, setTo] = useState(todayIso());
  const valid = !!from && !!to && from <= to;
  const indicators = useQuery(statsQuery<Indicators>("indicators", from, to, valid));
  const occupancy = useQuery(statsQuery<Occupancy>("occupancy", from, to, valid));
  const heatmap = useQuery(statsQuery<Heatmap>("heatmap", from, to, valid));
  const revenue = useQuery(statsQuery<Revenue>("revenue", from, to, valid));
  const top = useQuery(statsQuery<TopMembers>("top-members", from, to, valid));
  const i = indicators.data;
  const lines = revenue.data?.lines ?? [];
  return (
    <>
      <PageHeader
        title="Statistiques coworking"
        actions={
          <>
            <input className="input" type="date" aria-label="Du" value={from} onChange={(e) => setFrom(e.target.value)} />
            <input className="input" type="date" aria-label="Au" value={to} onChange={(e) => setTo(e.target.value)} />
          </>
        }
      />
      <ErrorBanner error={indicators.error ?? occupancy.error ?? heatmap.error ?? revenue.error ?? top.error} />
      {indicators.isPending ? (
        <Loading />
      ) : i ? (
        <>
          <div className="grid4">
            <Kpi label="Réservations" value={i.bookings} sub="honorées ou à venir sur la période" />
            <Kpi label="Taux d'absence" value={percent(i.noShowRate)} sub={`${i.noShows} absence(s)`} tone={i.noShowRate > 1_000 ? "amber" : undefined} />
            <Kpi label="Annulations tardives" value={percent(i.lateCancellationRate)} sub={`${i.lateCancellations} annulation(s)`} />
            <Kpi label="Durée moyenne" value={durationLabel(i.averageMinutes)} sub={`réservée ${leadLabel(i.averageLeadMinutes)} à l'avance en moyenne`} />
          </div>
          <div className="grid4">
            <Kpi
              label="Revenu mensuel récurrent"
              value={<span className="num">{tnd(i.monthlyRecurringRevenue)}</span>}
              sub="TND, abonnements actifs en fin de période"
            />
            <Kpi label="Abonnements actifs" value={i.activeSubscriptions} sub="au dernier jour de la période" />
            <Kpi label="Clients convertis" value={i.convertedGuests} sub="clients de passage devenus membres" />
            <Kpi
              label="Encaissé"
              value={<span className="num">{tnd(lines.reduce((s, l) => s + l.collected, 0))}</span>}
              sub={`TND sur ${tnd(lines.reduce((s, l) => s + l.issued, 0))} TND facturés`}
            />
          </div>
        </>
      ) : null}
      <Card
        title="Occupation par ressource"
        actions={occupancy.data ? <span className="cap">{durationLabel(occupancy.data.openMinutes)} d'ouverture sur la période</span> : null}
      >
        {occupancy.isPending ? (
          <Loading />
        ) : !occupancy.data?.resources.length ? (
          <Empty title="Aucune ressource réservable" />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Ressource</th>
                  <th className="num">Réservé</th>
                  <th style={{ width: "30%" }}>Taux de réservation</th>
                  <th className="num">Utilisé</th>
                  <th className="num">Taux d'utilisation</th>
                </tr>
              </thead>
              <tbody>
                {occupancy.data.resources.map((r) => (
                  <tr key={r.resourceId}>
                    <td>
                      {r.code}
                      <div className="cap">
                        {r.typeName} · {CATEGORY[r.category]}
                      </div>
                    </td>
                    <td className="num">{durationLabel(r.bookedMinutes)}</td>
                    <td>
                      <div className="row center" style={{ gap: 8 }}>
                        <Bar value={r.bookedRate / 100} tone={rateTone(r.bookedRate)} />
                        <span className="num">{percent(r.bookedRate)}</span>
                      </div>
                    </td>
                    <td className="num">{durationLabel(r.usedMinutes)}</td>
                    <td className="num">{percent(r.usedRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {heatmap.isPending ? (
        <Loading />
      ) : (
        heatmap.data?.types.map((t) => (
          <Card
            key={t.typeId}
            title={`Affluence : ${t.typeName}`}
            actions={<span className="cap">% réservé par jour et par heure, {t.resources} ressource(s)</span>}
          >
            {t.cells.length ? <HeatTable type={t} /> : <Empty title="Aucune heure d'ouverture sur la période" />}
          </Card>
        ))
      )}
      <div className="grid2" style={{ alignItems: "start" }}>
        <Card title="Revenus par type">
          {revenue.isPending ? (
            <Loading />
          ) : lines.length === 0 ? (
            <Empty title="Aucun revenu sur la période" />
          ) : (
            <div className="xs">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Origine</th>
                    <th className="num">Facturé (TND)</th>
                    <th className="num">Encaissé (TND)</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={`${l.source}${l.typeId ?? ""}`}>
                      <td>
                        {SOURCE[l.source]}
                        <div className="cap">{l.typeName ?? "Sans ressource attribuée"}</div>
                      </td>
                      <td className="num">{tnd(l.issued)}</td>
                      <td className="num">{tnd(l.collected)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Total</td>
                    <td className="num">{tnd(lines.reduce((s, l) => s + l.issued, 0))}</td>
                    <td className="num">{tnd(lines.reduce((s, l) => s + l.collected, 0))}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Card>
        <Card title="Meilleurs clients">
          {top.isPending ? (
            <Loading />
          ) : !top.data?.items.length ? (
            <Empty title="Aucun encaissement sur la période" />
          ) : (
            <div className="xs">
              <table className="tbl">
                <tbody>
                  {top.data.items.map((m) => (
                    <tr key={m.memberId}>
                      <td>
                        <Link to={`/coworking/membres/${m.memberId}`}>{m.name}</Link>
                        {m.company ? <div className="cap">{m.company}</div> : null}
                      </td>
                      <td className="num">{tnd(m.collected)} TND</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
