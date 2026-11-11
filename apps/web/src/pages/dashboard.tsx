import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import { useSession } from "../auth/session";
import { usePage } from "../components/shell";
import { Card, Empty, ErrorBanner, Kpi, Segmented } from "../components/ui";
import { frDate, frTime, percent, tnd, todayIso } from "../lib/format";
import { useActionQueue } from "../lib/action-queue";
import { ActionNotices } from "../components/notifications";
import type { PlanningDay } from "./coworking/api";
import { longDate } from "./launchpad";

import type { Dashboard, Granularity } from "../lib/dashboard";

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
  const { session, can } = useSession();
  const queue = useActionQueue();
  const [granularity, setGranularity] = useState<Granularity>("day");
  const canDashboard = can("dashboard:financial") || can("dashboard:operational");
  const data = useQuery({
    queryKey: ["dashboard", granularity],
    queryFn: () => api.get<Dashboard>("/dashboard", { granularity }),
    enabled: canDashboard,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
  const today = data.data?.today ?? todayIso();
  const coworking = useQuery({
    queryKey: ["cw-planning", today],
    queryFn: () => api.get<PlanningDay>("/coworking/planning", { date: today }),
    enabled: can("coworking:read"),
    refetchInterval: 30_000,
  });
  const refresh = () => {
    void queue.refresh();
    if (canDashboard) void data.refetch();
    if (can("coworking:read")) void coworking.refetch();
  };
  const d = data.data;
  const f = canDashboard ? d?.financial : undefined;
  const o = canDashboard && can("catalogue:read") ? d?.operational : undefined;
  const bookings = [
    ...new Map(
      (coworking.data?.floors ?? [])
        .flatMap((floor) =>
          floor.resources.flatMap((resource) =>
            resource.bookings
              .filter((b) => b.kind === "booking" && ["confirmed", "checked_in", "completed"].includes(b.status))
              .map((b) => [b.id, { ...b, resourceCode: resource.code }] as const),
          ),
        )
        .map(([id, b]) => [id, b]),
    ).values(),
  ];
  const urgent = queue.items.filter((i) => i.priority === "urgent").length;
  const [priority, setPriority] = useState<"all" | "urgent" | "attention" | "info">("all");
  const notices = queue.items.filter((i) => priority === "all" || priority === i.priority);
  const agenda = [
    ...(o?.agenda ?? []).map((a) => ({
      id: a.id,
      startsAt: a.startsAt,
      title: a.label,
      sub: [a.instructorName, a.roomName].filter(Boolean).join(" · "),
      to: a.type === "session" ? `/presences/${a.id}` : "/planning",
      label: a.type === "session" ? "Séance" : "Location",
    })),
    ...bookings.map((b) => ({
      id: b.id,
      startsAt: b.startsAt,
      title: b.memberName ?? "Réservation coworking",
      sub: b.resourceCode,
      to: `/coworking/reservations/${b.id}`,
      label: "Coworking",
    })),
  ].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return (
    <div className="operations-dashboard">
      <header className="launch-heading">
        <div>
          <h1>Votre centre, aujourd’hui</h1>
          <p>Bonjour{session?.user.fullName ? ` ${session.user.fullName.split(/\s+/)[0]}` : ""}. Retrouvez les priorités et l’activité du centre.</p>
        </div>
        <div className="dashboard-header-actions">
          <span className="launch-date">{longDate()}</span>
          <Link className="btn" to="/raccourcis">
            Mes raccourcis
          </Link>
          <button type="button" className="btn btn-g" onClick={refresh}>
            Actualiser
          </button>
        </div>
      </header>
      <ErrorBanner error={queue.error ?? data.error ?? coworking.error} retry={refresh} />
      <section className="dashboard-kpis" aria-label="Indicateurs du centre" aria-busy={queue.busy}>
        {f ? (
          <>
            <Kpi
              label="Encaissé ce mois"
              value={<span className="num">{tnd(f.collectionsMonth)}</span>}
              sub={`TND · ${tnd(f.collectionsToday)} TND aujourd’hui${f.cafeMonth > 0 ? ` · dont café ${tnd(f.cafeMonth)} TND ce mois` : ""}`}
            />
            <Kpi
              label="Impayés"
              value={<span className="num">{tnd(f.unpaidTotal)}</span>}
              sub={`TND · ${f.unpaidPayers} payeur(s) en retard`}
              tone={f.unpaidTotal > 0 ? "amber" : undefined}
            />
          </>
        ) : canDashboard && data.isPending ? (
          <>
            <Kpi label="Activité du centre" value="…" sub="Chargement des indicateurs…" />
          </>
        ) : null}
        {o ? (
          <Kpi
            label="Séances et locations"
            value={o.agenda.length}
            sub={`Aujourd’hui · présence ${o.attendanceRateBasisPoints === null ? "non disponible" : percent(o.attendanceRateBasisPoints)}`}
          />
        ) : null}
        {can("coworking:read") ? (
          <Kpi
            label="Réservations coworking"
            value={coworking.isPending ? "…" : coworking.error ? "—" : bookings.length}
            sub="Confirmées, en cours ou terminées aujourd’hui"
          />
        ) : null}
        {can("coworking:write") && (!f || !o) ? (
          <Kpi
            label="Inscriptions à valider"
            value={queue.busy ? "…" : queue.memberCount}
            sub="Nouveaux comptes de l’espace client"
            tone={queue.memberCount ? "amber" : undefined}
          />
        ) : null}
        {!f && !o && can("website:leads") ? (
          <Kpi
            label="Messages du site à traiter"
            value={queue.busy ? "…" : `${queue.leadCount}${queue.more ? "+" : ""}`}
            sub="Contacts, visites et demandes de devis"
          />
        ) : null}
      </section>
      <div className="dashboard-columns">
        <section className="dashboard-priorities card" aria-labelledby="priorities-title">
          <div className="dashboard-card-head">
            <div>
              <h2 id="priorities-title">Votre attention est nécessaire</h2>
              <p>
                {queue.busy
                  ? "Actualisation des actions…"
                  : `${queue.total} ${queue.total === 1 ? "action en attente" : "actions en attente"}${urgent ? `, dont ${urgent} ${urgent === 1 ? "urgente" : "urgentes"}` : ""}`}
              </p>
            </div>
            <span className={`dashboard-priority-total${urgent ? " urgent" : ""}`}>
              {queue.total}
              {queue.more ? "+" : ""}
            </span>
          </div>
          <div className="dashboard-filters" role="group" aria-label="Priorité des notifications">
            {(
              [
                { id: "all", text: "Tout" },
                { id: "urgent", text: "Urgent" },
                { id: "attention", text: "À traiter" },
                { id: "info", text: "À suivre" },
              ] as const
            ).map((filter) => (
              <button type="button" key={filter.id} aria-pressed={priority === filter.id} onClick={() => setPriority(filter.id)}>
                {filter.text}
              </button>
            ))}
          </div>
          {notices.length ? (
            <ActionNotices items={notices} />
          ) : (
            <Empty
              title={
                queue.busy
                  ? "Chargement des actions…"
                  : queue.error
                    ? "Certaines informations sont indisponibles"
                    : priority === "all"
                      ? "Tout est à jour"
                      : "Aucune action dans cette catégorie"
              }
              text={queue.error ? "Réessayez l’actualisation pour vérifier toutes les priorités." : ""}
            />
          )}
        </section>
        <section className="card dashboard-agenda" aria-labelledby="agenda-title">
          <div className="dashboard-card-head">
            <div>
              <h2 id="agenda-title">Au programme aujourd’hui</h2>
              <p>Séances, locations et coworking</p>
            </div>
            <span className="dashboard-priority-total">{agenda.length}</span>
          </div>
          {agenda.length ? (
            <ol className="dashboard-agenda-list">
              {agenda.slice(0, 6).map((a) => (
                <li key={`${a.label}-${a.id}`}>
                  <time dateTime={a.startsAt}>{frTime(a.startsAt)}</time>
                  <div>
                    <span className="cap">{a.label}</span>
                    <Link to={a.to}>{a.title}</Link>
                    <p>{a.sub}</p>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <Empty title={data.isFetching || coworking.isFetching ? "Chargement du programme…" : "Rien de prévu aujourd’hui"} />
          )}
          <div className="dashboard-agenda-links">
            {can("catalogue:read") ? <Link to="/planning">Planning des cours</Link> : null}
            {can("coworking:read") ? <Link to="/coworking/planning">Planning coworking</Link> : null}
          </div>
        </section>
      </div>
      {f && d ? (
        <Card
          title="Évolution des encaissements"
          actions={
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
          }
        >
          <div className="card-b dashboard-chart">
            <Chart series={f.series} granularity={granularity} today={d.today} />
          </div>
        </Card>
      ) : null}
    </div>
  );
}
