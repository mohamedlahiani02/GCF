import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import { useSession } from "../auth/session";
import { usePage } from "../components/shell";
import { Badge, Card, Empty, ErrorBanner, Kpi, Loading, PageHeader, Segmented } from "../components/ui";
import { frDate, frTime, monthLabel, percent, tnd } from "../lib/format";
import { SHEET } from "../lib/labels";

type Granularity = "day" | "week" | "month";
interface Dashboard {
  today: string;
  sections: { financial: boolean; operational: boolean };
  financial?: {
    collectionsToday: number;
    collectionsMonth: number;
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

const DAYS = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

function bucketLabel(bucket: string, granularity: Granularity, today: string): string {
  const d = new Date(`${bucket}T00:00:00Z`);
  if (granularity === "day") return bucket === today ? "Auj." : `${DAYS[d.getUTCDay()]} ${d.getUTCDate()}`;
  if (granularity === "week") return `${d.getUTCDate()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return MONTHS[d.getUTCMonth()] ?? "";
}

/** Whole TND with a regular space as thousands separator, for chart labels. */
const axis = (millimes: number) => String(Math.round(millimes / 1000)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

function Chart({ series, granularity, today }: { series: { bucket: string; total: number }[]; granularity: Granularity; today: string }) {
  // Three gridline steps of a whole multiple of a power of ten (in TND) that cover the highest bar.
  const roughStep = Math.max(1, Math.max(0, ...series.map((s) => s.total)) / 1000 / 3);
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const top = Math.ceil(roughStep / magnitude) * magnitude * 3 * 1000;
  const width = 640;
  const left = 48;
  const plot = 150;
  const slot = (width - left - 10) / series.length;
  const bar = Math.min(48, slot * 0.6);
  return (
    <svg viewBox={`0 0 ${width} 220`} width="100%" role="img" aria-label="Encaissements par période">
      <g stroke="#DDE1E8" strokeWidth="1">
        {[0, 1, 2, 3].map((i) => (
          <line key={i} x1={left} y1={20 + i * 50} x2={width - 10} y2={20 + i * 50} />
        ))}
      </g>
      <g fill="#566274" fontSize="11" textAnchor="end">
        {[0, 1, 2, 3].map((i) => (
          <text key={i} x={left - 6} y={24 + i * 50}>
            {axis((top * (3 - i)) / 3)}
          </text>
        ))}
      </g>
      {series.map((s, i) => {
        const h = Math.round((s.total / top) * plot);
        const x = left + i * slot + (slot - bar) / 2;
        return (
          <g key={s.bucket}>
            <rect x={x} y={170 - h} width={bar} height={h} rx={3} fill="#0E5A8A" />
            {s.total > 0 ? (
              <text x={x + bar / 2} y={164 - h} fontSize="11" textAnchor="middle" fontWeight="600" fill="#1B2430">
                {axis(s.total)}
              </text>
            ) : null}
            <text x={x + bar / 2} y={192} fontSize="11" textAnchor="middle" fill="#566274">
              {bucketLabel(s.bucket, granularity, today)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function DashboardPage() {
  usePage(["Tableau de bord"]);
  const { can } = useSession();
  const [granularity, setGranularity] = useState<Granularity>("day");
  const data = useQuery({ queryKey: ["dashboard", granularity], queryFn: () => api.get<Dashboard>("/dashboard", { granularity }) });
  if (data.isPending) return <Loading />;
  if (data.error) return <ErrorBanner error={data.error} retry={() => data.refetch()} />;
  const d = data.data;
  const f = d.financial;
  const o = d.operational;
  const todo: { title: string; sub: string; to: string; action: string }[] = [];
  if (o) {
    if (o.todo.sessionsWithoutSheet.length)
      todo.push({
        title: `${o.todo.sessionsWithoutSheet.length} feuille(s) de présence à valider`,
        sub: o.todo.sessionsWithoutSheet
          .slice(0, 3)
          .map((s) => `${s.groupName}, ${frDate(s.startsAt)} ${frTime(s.startsAt)}`)
          .join(" · "),
        to: `/presences/${o.todo.sessionsWithoutSheet[0]!.id}`,
        action: "Faire l'appel",
      });
    if (o.todo.overdueInstallments.count)
      todo.push({
        title: `${o.todo.overdueInstallments.count} échéance(s) en retard`,
        sub: `${tnd(o.todo.overdueInstallments.total)} TND restant dus`,
        to: "/encaissements",
        action: "Voir",
      });
    if (o.todo.remindersToSend)
      todo.push({
        title: `${o.todo.remindersToSend} relance(s) à envoyer`,
        sub: "Payeurs en retard non relancés depuis 7 jours",
        to: "/encaissements",
        action: "Relancer",
      });
    if (o.todo.unclosedCashDays.length)
      todo.push({
        title: `${o.todo.unclosedCashDays.length} journée(s) de caisse non clôturée(s)`,
        sub: o.todo.unclosedCashDays.map(frDate).join(", "),
        to: `/caisse?date=${o.todo.unclosedCashDays[0]}`,
        action: "Clôturer",
      });
  }
  return (
    <>
      <PageHeader
        title="Tableau de bord"
        actions={
          f ? (
            <>
              <span className="cap">Période</span>
              <Segmented
                label="Période du graphique"
                value={granularity}
                onChange={setGranularity}
                options={[
                  { value: "day", label: "Jour" },
                  { value: "week", label: "Semaine" },
                  { value: "month", label: "Mois" },
                ]}
              />
            </>
          ) : null
        }
      />
      <section className="grid4" aria-label="Indicateurs">
        {f ? (
          <>
            <Kpi label="Encaissé aujourd'hui" value={<span className="num">{tnd(f.collectionsToday)}</span>} sub="TND" />
            <Kpi label="Encaissé ce mois" value={<span className="num">{tnd(f.collectionsMonth)}</span>} sub={`TND, ${monthLabel(d.today)}`} />
            <Kpi
              label="Impayés"
              value={<span className="num">{tnd(f.unpaidTotal)}</span>}
              sub={`TND, ${f.unpaidPayers} payeur(s) en retard`}
              tone={f.unpaidTotal > 0 ? "red" : undefined}
            />
            <Kpi
              label="Paie des intervenants à régler"
              value={<span className="num">{tnd(f.payroll.toPay)}</span>}
              sub={`TND validés ; ${tnd(f.payroll.toValidate)} TND calculés à valider`}
              tone={f.payroll.toPay > 0 ? "amber" : undefined}
            />
          </>
        ) : null}
        {o ? (
          <>
            <Kpi label="Taux de présence" value={percent(o.attendanceRateBasisPoints)} sub="Ce mois, feuilles validées" />
            <Kpi label="Occupation des salles" value={percent(o.roomOccupancyBasisPoints)} sub="Cette semaine, heures d'ouverture" />
          </>
        ) : null}
        {f ? <Kpi label="Échéances reportées" value={f.postponedInstallments} sub="encore ouvertes" /> : null}
      </section>
      <div className="grid2" style={{ alignItems: "start" }}>
        {f ? (
          <Card title="Encaissements" actions={<span className="cap">TND</span>}>
            <div className="card-b">
              <Chart series={f.series} granularity={granularity} today={d.today} />
            </div>
          </Card>
        ) : null}
        {o ? (
          <Card title="À faire aujourd'hui" actions={todo.length ? <Badge tone="red">{todo.length}</Badge> : <Badge tone="green">Rien</Badge>}>
            {todo.length === 0 ? (
              <Empty title="Tout est à jour" />
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {todo.map((t) => (
                  <li key={t.title} className="row between center" style={{ padding: "10px 16px", borderTop: "1px solid var(--line)", gap: 12 }}>
                    <div>
                      <div>{t.title}</div>
                      <div className="cap">{t.sub}</div>
                    </div>
                    <Link className="btn" to={t.to}>
                      {t.action}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : null}
      </div>
      {o ? (
        <Card title="Séances et locations du jour" actions={can("catalogue:read") ? <Link to="/planning">Ouvrir le planning</Link> : null}>
          {o.agenda.length === 0 ? (
            <Empty title="Rien de prévu aujourd'hui" />
          ) : (
            <div className="xs">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Heure</th>
                    <th>Activité</th>
                    <th>Intervenant</th>
                    <th>Salle</th>
                    <th>Feuille</th>
                  </tr>
                </thead>
                <tbody>
                  {o.agenda.map((a) => (
                    <tr key={`${a.type}${a.id}`}>
                      <td className="num">
                        {frTime(a.startsAt)} - {frTime(a.endsAt)}
                      </td>
                      <td>{a.type === "session" ? <Link to={`/presences/${a.id}`}>{a.label}</Link> : `Location : ${a.label}`}</td>
                      <td>{a.instructorName ?? ""}</td>
                      <td>{a.roomName ?? ""}</td>
                      <td>{a.sheetStatus ? <Badge tone={SHEET[a.sheetStatus]?.tone ?? "neutral"}>{SHEET[a.sheetStatus]?.label}</Badge> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}
    </>
  );
}
