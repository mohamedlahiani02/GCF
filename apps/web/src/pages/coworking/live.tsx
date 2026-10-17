import { FloorPlanView } from "@gcf/floorplan";
import { ASSIGNED_CATEGORIES, PLAN_STATES, addDays, type PlanState } from "@gcf/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../../api/client";
import { useSession } from "../../auth/session";
import { usePage } from "../../components/shell";
import { Badge, Card, Drawer, Empty, ErrorBanner, Kpi, Loading, PageHeader, Segmented, Tabs } from "../../components/ui";
import { addDaysIso, frDate, todayIso, weekdayLabel, zonedIso } from "../../lib/format";
import {
  CATEGORY,
  PLAN_STATE,
  floorImage,
  fromMinutes,
  toMinutes,
  useFloorDetail,
  useFloors,
  type Booking,
  type FloorState,
  type PlanningDay,
  type RequestRow,
  type ResourceState,
} from "./api";
import { BlockModal, BlockPanel, BookingPanel, QuickBooking, isDeskBookable, quarterNow, useMemberCollect } from "./bookingParts";

const REFRESH_MS = 30_000;
const HEAT_DAYS = 30;

/** Legend of the plan states, with the colours of the floor plan. */
export function PlanLegend() {
  return (
    <div className="fp-legend" aria-label="Légende du plan">
      {PLAN_STATES.map((s) => (
        <span key={s}>
          <i className={s} aria-hidden="true" />
          {PLAN_STATE[s]}
        </span>
      ))}
    </div>
  );
}

function HeatLegend() {
  return (
    <div className="fp-legend" aria-label="Légende de l'occupation">
      {[0, 25, 50, 75, 100].map((rate) => (
        <span key={rate}>
          <i className="cw-heat-swatch" style={{ opacity: 0.15 + 0.85 * (rate / 100) }} aria-hidden="true" />
          {rate} %
        </span>
      ))}
      <span>Taux de réservation des {HEAT_DAYS} derniers jours, heures d'ouverture</span>
    </div>
  );
}

function stateTitle(r: ResourceState): string {
  const who = r.occupant?.memberName ?? r.subscriber?.memberName ?? (r.occupant?.kind === "block" ? r.occupant.notes : null);
  return `${r.code}, ${r.typeName} : ${PLAN_STATE[r.state]}${who ? `, ${who}` : ""}`;
}

/** What the drawer shows for a resource, by its state on the plan. */
function ResourceDrawer({
  resource,
  date,
  time,
  onClose,
  onBlock,
  onCollect,
}: {
  resource: ResourceState;
  date: string;
  time: string;
  onClose: () => void;
  onBlock: () => void;
  onCollect: (memberId: string) => void;
}) {
  const { can } = useSession();
  const [createdId, setCreatedId] = useState<string | null>(null);
  const bookingId = createdId ?? (resource.occupant?.kind === "booking" ? resource.occupant.bookingId : null);
  let body;
  if (bookingId) {
    body = <BookingPanel bookingId={bookingId} onCollect={onCollect} />;
  } else if (resource.occupant?.kind === "block") {
    body = <BlockFromState resource={resource} />;
  } else if (resource.state === "assigned" && resource.subscriber) {
    body = (
      <div className="stack">
        <Badge tone="violet">Attribué par abonnement</Badge>
        <div>
          <Link to={`/coworking/membres/${resource.subscriber.memberId}`}>{resource.subscriber.memberName}</Link>
          {resource.subscriber.company ? <span className="cap"> · {resource.subscriber.company}</span> : null}
        </div>
        <span className="cap">Abonnement jusqu'au {frDate(resource.subscriber.endsOn)}</span>
      </div>
    );
  } else if (resource.status === "out_of_service") {
    body = (
      <div className="ban ban-amber">
        <span>Ressource hors service : elle se remet en service dans les paramètres coworking.</span>
      </div>
    );
  } else if (ASSIGNED_CATEGORIES.includes(resource.category)) {
    body = (
      <div className="ban ban-blue">
        <span>{CATEGORY[resource.category]} sans abonné à cette date : il s'attribue en vendant un abonnement depuis la fiche d'un membre.</span>
      </div>
    );
  } else if (can("coworking:write") && isDeskBookable(resource)) {
    body = (
      <QuickBooking
        resource={{ id: resource.resourceId, code: resource.code, typeId: resource.typeId }}
        date={date}
        time={time}
        autoFocus
        onCreated={(b) => setCreatedId(b.id)}
      />
    );
  } else {
    body = <span className="cap">Ressource libre.</span>;
  }
  return (
    <Drawer
        title={`${resource.code} · ${resource.typeName}`}
        onClose={onClose}
        footer={
          can("coworking:write") && !bookingId && resource.state !== "blocked" ? (
            <button type="button" className="btn" onClick={onBlock}>
              Bloquer cette ressource
            </button>
          ) : undefined
        }
      >
        <div className="row center" style={{ gap: 8 }}>
          <span className="cap">
            {CATEGORY[resource.category]} · {resource.capacity} place(s)
          </span>
          <Badge tone="neutral">{PLAN_STATE[resource.state]}</Badge>
        </div>
        {body}
      </Drawer>
  );
}

function BlockFromState({ resource }: { resource: ResourceState }) {
  const detail = useQuery({
    queryKey: ["cw-booking", resource.occupant!.bookingId],
    queryFn: () => api.get<Booking>(`/coworking/bookings/${resource.occupant!.bookingId}`),
  });
  if (detail.isPending) return <Loading />;
  if (detail.error) return <ErrorBanner error={detail.error} />;
  return <BlockPanel block={detail.data} />;
}

/**
 * Live floor plan of the desk: each resource coloured by its state at the chosen moment (now by default, refreshed
 * every 30 seconds), counters on top, a drawer per resource for booking, check-in, release and payment, and an
 * occupancy heat map of the last 30 days for the users who see the statistics.
 */
export function LivePlanPage() {
  usePage(["Coworking", "Plan en direct"]);
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const floors = useFloors();
  const floorId = params.get("etage") ?? floors.data?.[0]?.id ?? null;
  const today = todayIso();
  const date = params.get("date") ?? today;
  const [pickedTime, setPickedTime] = useState<string | null>(null);
  const [view, setView] = useState<"state" | "heat">("state");
  const [selected, setSelected] = useState<string | null>(null);
  const [blocking, setBlocking] = useState<{ resourceId?: string } | null>(null);
  const collect = useMemberCollect();
  const live = date === today && pickedTime === null;
  const update = (patch: Record<string, string>) => setParams({ ...(floorId ? { etage: floorId } : {}), date, ...patch });

  const day = useQuery({ queryKey: ["cw-planning", date], queryFn: () => api.get<PlanningDay>("/coworking/planning", { date }) });
  const open = day.data?.open ?? null;
  const openFrom = open ? toMinutes(open.from) : 8 * 60;
  const lastStart = open ? Math.max(openFrom, toMinutes(open.to) - 15) : 20 * 60;
  const nowTime = quarterNow().time;
  const time = pickedTime ?? (date === today ? nowTime : fromMinutes(openFrom));
  const sliderValue = Math.min(lastStart, Math.max(openFrom, toMinutes(time)));

  const floor = useFloorDetail(floorId);
  const state = useQuery({
    queryKey: ["cw-floor-state", floorId, live ? "now" : `${date}T${time}`],
    queryFn: () => api.get<FloorState>(`/coworking/floors/${floorId}/state`, { at: live ? new Date().toISOString() : zonedIso(date, time) }),
    enabled: !!floorId,
    refetchInterval: live ? REFRESH_MS : false,
  });
  const requests = useQuery({
    queryKey: ["cw-requests"],
    queryFn: () => api.get<{ items: RequestRow[] }>("/coworking/requests"),
    refetchInterval: REFRESH_MS,
  });
  const heat = useQuery({
    queryKey: ["cw-occupancy", today, HEAT_DAYS],
    queryFn: () =>
      api.get<{ resources: { resourceId: string; bookedRate: number }[] }>("/coworking/stats/occupancy", {
        from: addDays(today, -HEAT_DAYS),
        to: addDays(today, -1),
      }),
    enabled: view === "heat" && can("coworking:reports"),
  });

  if (floors.isPending) return <Loading />;
  if (floors.error) return <ErrorBanner error={floors.error} retry={() => floors.refetch()} />;
  if (!floors.data.length || !floorId) {
    return (
      <>
        <PageHeader title="Plan en direct" />
        <Card>
          <Empty title="Aucun étage configuré" text="Les étages, leurs ressources et leur plan se créent dans les paramètres coworking." />
        </Card>
      </>
    );
  }

  const resources = state.data?.resources ?? [];
  const byId = new Map(resources.map((r) => [r.resourceId, r]));
  const count = (s: PlanState) => resources.filter((r) => r.state === s).length;
  const heatById = new Map((heat.data?.resources ?? []).map((r) => [r.resourceId, r.bookedRate]));
  const layout = state.data?.floor.layout ?? floor.data?.layout;
  const placed = new Set((layout?.items ?? []).map((i) => i.resourceId));
  const unplaced = resources.filter((r) => !placed.has(r.resourceId));
  const selectedResource = selected ? byId.get(selected) : undefined;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;

  return (
    <>
      <PageHeader
        title="Plan en direct"
        subtitle={
          <span className="row center" style={{ gap: 8 }}>
            <span>
              {weekdayLabel(weekday)} {frDate(date)} à {time}
            </span>
            {live ? <Badge tone="green">En direct, mis à jour toutes les 30 s</Badge> : <Badge tone="neutral">Consultation</Badge>}
          </span>
        }
        actions={
          <>
            {can("coworking:reports") ? (
              <Segmented
                label="Coloration du plan"
                value={view}
                onChange={setView}
                options={[
                  { value: "state", label: "États" },
                  { value: "heat", label: `Occupation ${HEAT_DAYS} j` },
                ]}
              />
            ) : null}
            {can("coworking:write") ? (
              <button type="button" className="btn" onClick={() => setBlocking({})}>
                Bloquer une ressource
              </button>
            ) : null}
          </>
        }
      />
      <div className="grid4">
        <Kpi label="Libres" value={count("free")} sub={`sur ${resources.length} ressource(s) de l'étage`} />
        <Kpi label="Réservées" value={count("booked")} sub="client attendu" />
        <Kpi label="Occupées" value={count("occupied")} sub="client arrivé" />
        <Kpi
          label="Demandes en attente"
          value={requests.data?.items.length ?? 0}
          sub={can("coworking:write") ? <Link to="/coworking/demandes">Traiter les demandes</Link> : "tous étages"}
          tone={requests.data?.items.length ? "amber" : undefined}
        />
      </div>
      <Tabs value={floorId} onChange={(id) => (setSelected(null), update({ etage: id }))} tabs={floors.data.map((f) => ({ value: f.id, label: f.name }))} />
      <Card>
        <div className="card-b stack">
          <div className="row center cw-live-controls">
            <button type="button" className="btn btn-g" aria-label="Jour précédent" onClick={() => (setPickedTime(null), update({ date: addDaysIso(date, -1) }))}>
              ‹
            </button>
            <input
              className="input"
              type="date"
              aria-label="Date"
              style={{ width: "auto" }}
              value={date}
              onChange={(e) => e.target.value && (setPickedTime(null), update({ date: e.target.value }))}
            />
            <button type="button" className="btn btn-g" aria-label="Jour suivant" onClick={() => (setPickedTime(null), update({ date: addDaysIso(date, 1) }))}>
              ›
            </button>
            <input
              className="cw-slider"
              type="range"
              aria-label="Heure"
              aria-valuetext={fromMinutes(sliderValue)}
              min={openFrom}
              max={lastStart}
              step={15}
              value={sliderValue}
              disabled={!open}
              onChange={(e) => setPickedTime(fromMinutes(Number(e.target.value)))}
            />
            <strong className="num">{open ? fromMinutes(sliderValue) : "Fermé"}</strong>
            {!live ? (
              <button type="button" className="btn" onClick={() => (setPickedTime(null), setParams({ etage: floorId }))}>
                Maintenant
              </button>
            ) : null}
          </div>
          {day.data && !open ? (
            <div className="ban ban-amber">
              <span>L'espace est fermé ce jour-là{day.data.closures.length ? ` : ${day.data.closures.join(", ")}` : ""}.</span>
            </div>
          ) : null}
          {view === "heat" ? <HeatLegend /> : <PlanLegend />}
          <ErrorBanner error={state.error ?? floor.error ?? heat.error} retry={() => state.refetch()} />
          {state.isPending || floor.isPending ? (
            <Loading />
          ) : layout && layout.items.length ? (
            <FloorPlanView
              layout={layout}
              image={floorImage(floor.data)}
              zones={floor.data?.zones}
              title={`Plan de ${state.data?.floor.name ?? ""}`}
              selectedId={selected}
              onSelect={setSelected}
              appearance={(id) => {
                const r = byId.get(id);
                if (!r) return undefined;
                if (view === "heat") {
                  const rate = heatById.get(id);
                  return {
                    label: r.code,
                    title: `${r.code}, ${r.typeName} : ${rate === undefined ? "non réservable" : `${Math.round(rate / 100)} % d'occupation`}`,
                    heat: rate === undefined ? 0 : rate / 10_000,
                  };
                }
                return { label: r.code, title: stateTitle(r), state: r.state };
              }}
            />
          ) : (
            <Empty title="Plan non publié" text="Placez les ressources de cet étage sur son plan dans les paramètres coworking." />
          )}
          {unplaced.length ? (
            <div className="row center" style={{ gap: 6, flexWrap: "wrap" }}>
              <span className="lab">Hors plan</span>
              {unplaced.map((r) => (
                <button key={r.resourceId} type="button" className="btn btn-g" title={stateTitle(r)} onClick={() => setSelected(r.resourceId)}>
                  {r.code} <span className="cap">{PLAN_STATE[r.state]}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </Card>
      {selectedResource ? (
        <ResourceDrawer
          key={selectedResource.resourceId}
          resource={selectedResource}
          date={date}
          time={time}
          onClose={() => setSelected(null)}
          onBlock={() => (setBlocking({ resourceId: selectedResource.resourceId }), setSelected(null))}
          onCollect={(memberId) => (setSelected(null), collect.open(memberId))}
        />
      ) : null}
      {blocking ? (
        <BlockModal
          resources={resources.filter((r) => r.status !== "archived").map((r) => ({ id: r.resourceId, code: r.code, typeName: r.typeName }))}
          resourceId={blocking.resourceId}
          date={date}
          time={time}
          onClose={() => setBlocking(null)}
        />
      ) : null}
      {collect.element}
    </>
  );
}
