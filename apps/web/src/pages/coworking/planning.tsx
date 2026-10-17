import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../../api/client";
import { usePage } from "../../components/shell";
import { Card, Drawer, Empty, ErrorBanner, Loading, PageHeader } from "../../components/ui";
import { addDaysIso, frDate, frTime, localParts, todayIso, weekdayLabel } from "../../lib/format";
import { BOOKING_STATUS, toMinutes, type PlanningBooking, type PlanningDay } from "./api";
import { BookingPanel, useMemberCollect } from "./bookingParts";

const BAR_CLASS: Record<string, string> = {
  requested: "cw-blk-requested",
  confirmed: "cw-blk-confirmed",
  checked_in: "cw-blk-checked-in",
  completed: "cw-blk-completed",
  no_show: "cw-blk-no-show",
};

const LEGEND: { cls: string; label: string }[] = [
  { cls: "cw-blk-requested", label: BOOKING_STATUS.requested.label },
  { cls: "cw-blk-confirmed", label: BOOKING_STATUS.confirmed.label },
  { cls: "cw-blk-checked-in", label: BOOKING_STATUS.checked_in.label },
  { cls: "cw-blk-completed", label: BOOKING_STATUS.completed.label },
  { cls: "cw-blk-no-show", label: BOOKING_STATUS.no_show.label },
  { cls: "cw-blk-block", label: "Blocage" },
];

/**
 * Day timeline of the coworking: one row per resource grouped by floor, hours of the day's opening as columns,
 * bookings and blocks as bars coloured by status. A bar opens the booking drawer.
 */
export function CoworkingPlanningPage() {
  usePage(["Coworking", "Planning coworking"]);
  const [params, setParams] = useSearchParams();
  const date = params.get("date") ?? todayIso();
  const [selected, setSelected] = useState<string | null>(null);
  const collect = useMemberCollect();
  const day = useQuery({ queryKey: ["cw-planning", date], queryFn: () => api.get<PlanningDay>("/coworking/planning", { date }) });
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;

  const open = day.data?.open ? toMinutes(day.data.open.from) : 8 * 60;
  const close = day.data?.open ? Math.max(open + 60, toMinutes(day.data.open.to)) : 20 * 60;
  const span = close - open;
  const hours: number[] = [];
  for (let m = Math.ceil(open / 60) * 60; m < close; m += 60) hours.push(m);

  const position = (b: PlanningBooking) => {
    const start = localParts(b.startsAt);
    const end = localParts(b.endsAt);
    const from = Math.max(open, start.date < date ? open : toMinutes(start.time));
    const to = Math.min(close, end.date > date ? close : toMinutes(end.time));
    return { left: `${((from - open) / span) * 100}%`, width: `${(Math.max(15, to - from) / span) * 100}%` };
  };
  const label = (b: PlanningBooking) => (b.kind === "block" ? (b.notes ?? "Blocage") : `${b.memberName ?? ""}${b.company ? ` · ${b.company}` : ""}`);
  const floors = day.data?.floors.filter((f) => f.resources.length) ?? [];

  return (
    <>
      <PageHeader
        title="Planning coworking"
        subtitle={`${weekdayLabel(weekday)} ${frDate(date)}${day.data?.open ? `, ouvert de ${day.data.open.from} à ${day.data.open.to}` : ""}`}
        actions={
          <>
            <button type="button" className="btn btn-g" aria-label="Jour précédent" onClick={() => setParams({ date: addDaysIso(date, -1) })}>
              ‹
            </button>
            <input className="input" type="date" aria-label="Date" value={date} onChange={(e) => e.target.value && setParams({ date: e.target.value })} />
            <button type="button" className="btn btn-g" aria-label="Jour suivant" onClick={() => setParams({ date: addDaysIso(date, 1) })}>
              ›
            </button>
            {date !== todayIso() ? (
              <button type="button" className="btn" onClick={() => setParams({})}>
                Aujourd'hui
              </button>
            ) : null}
          </>
        }
      />
      {day.data && !day.data.open ? (
        <div className="ban ban-amber">
          <span>L'espace est fermé ce jour-là{day.data.closures.length ? ` : ${day.data.closures.join(", ")}` : ""}.</span>
        </div>
      ) : null}
      <div className="row center" style={{ gap: 10, flexWrap: "wrap" }}>
        <span className="lab">Légende</span>
        {LEGEND.map((l) => (
          <span key={l.cls} className={`blk ${l.cls}`}>
            {l.label}
          </span>
        ))}
        <span className="cap" style={{ marginInlineStart: 12 }}>
          Cliquez sur une réservation pour l'ouvrir.
        </span>
      </div>
      <Card>
        <ErrorBanner error={day.error} retry={() => day.refetch()} />
        {day.isPending ? (
          <Loading />
        ) : floors.length === 0 ? (
          <Empty title="Aucune ressource" text="Les ressources se créent dans les paramètres coworking." />
        ) : (
          <div className="xs">
            <div style={{ minWidth: 1000, padding: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "150px 1fr" }}>
                <div />
                <div style={{ position: "relative", height: 18 }}>
                  {hours.map((m) => (
                    <span
                      key={m}
                      className="cap num"
                      style={{ position: "absolute", left: `${((m - open) / span) * 100}%`, paddingInlineStart: 4, borderInlineStart: "1px solid var(--line)" }}
                    >
                      {m / 60}h
                    </span>
                  ))}
                </div>
              </div>
              {floors.map((f) => (
                <section key={f.id} aria-label={f.name}>
                  <div className="cw-floor-row">
                    <strong>{f.name}</strong>
                  </div>
                  {f.resources.map((r) => (
                    <div key={r.id} style={{ display: "grid", gridTemplateColumns: "150px 1fr", borderTop: "1px solid var(--line)" }}>
                      <div style={{ padding: "8px 4px" }}>
                        <strong>{r.code}</strong>
                        <div className="cap">
                          {r.typeName}
                          {r.status === "out_of_service" ? " · hors service" : ""}
                        </div>
                      </div>
                      <div className="timeline-row" style={{ borderTop: 0 }}>
                        {r.bookings.map((b) => (
                          <button
                            key={b.id}
                            type="button"
                            className={`blk ${b.kind === "block" ? "cw-blk-block" : (BAR_CLASS[b.status] ?? "cw-blk-completed")}`}
                            style={position(b)}
                            title={`${b.kind === "block" ? "Blocage" : BOOKING_STATUS[b.status].label} ${frTime(b.startsAt)}-${frTime(b.endsAt)} · ${label(b)}`}
                            onClick={() => setSelected(b.id)}
                          >
                            <div style={{ fontWeight: 600 }}>{label(b)}</div>
                            <div>
                              {frTime(b.startsAt)}-{frTime(b.endsAt)}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </div>
        )}
      </Card>
      {selected ? (
        <Drawer title="Réservation" onClose={() => setSelected(null)}>
          <BookingPanel bookingId={selected} onCollect={(memberId) => (setSelected(null), collect.open(memberId))} />
        </Drawer>
      ) : null}
      {collect.element}
    </>
  );
}
