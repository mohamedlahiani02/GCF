import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "../api/client";
import type { Room } from "../api/types";
import { useSession } from "../auth/session";
import { usePage } from "../components/shell";
import { Badge, Card, Empty, ErrorBanner, Loading, PageHeader, Segmented } from "../components/ui";
import { addDaysIso, frDate, frTime, localParts, todayIso, weekdayLabel } from "../lib/format";
import { MoveSessionModal, type PlanningItem } from "./groups";
import { MonthView, WeekView, periodRange, periodTitle, shiftPeriod, type Period } from "./planningCalendar";

type View = "room" | "instructor" | "group";
interface Centre {
  openFrom: string;
  openTo: string;
}

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const TYPE_LABEL: Record<PlanningItem["type"], string> = { course: "Cours", training: "Formation", rental: "Location" };

interface Row {
  key: string;
  name: string;
  sub: string;
  items: PlanningItem[];
}

/** Items of a row that overlap another item of the same row. */
function overlapping(items: PlanningItem[]): Set<string> {
  const ids = new Set<string>();
  for (const a of items) {
    for (const b of items) {
      if (a === b) continue;
      if (new Date(a.startsAt) < new Date(b.endsAt) && new Date(b.startsAt) < new Date(a.endsAt)) ids.add(`${a.type}${a.id}`);
    }
  }
  return ids;
}

export function PlanningPage() {
  usePage(["Planning"]);
  const { can } = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const date = params.get("date") ?? todayIso();
  const view = (params.get("vue") as View | null) ?? "room";
  const period = (params.get("periode") as Period | null) ?? "day";
  const update = (patch: Record<string, string>) => setParams({ date, vue: view, periode: period, ...patch });
  const range = periodRange(period, date);
  const [moving, setMoving] = useState<PlanningItem | null>(null);
  const centre = useQuery({ queryKey: ["centre-settings"], queryFn: () => api.get<Centre>("/centre") });
  const rooms = useQuery({ queryKey: ["rooms"], queryFn: () => api.get<Room[]>("/catalogue/rooms") });
  const planning = useQuery({ queryKey: ["planning", range.from, range.to], queryFn: () => api.get<{ items: PlanningItem[] }>("/planning", range) });

  const open = minutesOf(centre.data?.openFrom ?? "08:00");
  const close = Math.max(open + 60, minutesOf(centre.data?.openTo ?? "20:00"));
  const span = close - open;
  const hours: number[] = [];
  for (let m = Math.ceil(open / 60) * 60; m < close; m += 60) hours.push(m);
  const allItems = planning.data?.items ?? [];
  const items = allItems;

  const rows: Row[] =
    view === "room"
      ? (rooms.data ?? [])
          .filter((r) => r.status === "active")
          .map((r) => ({ key: r.id, name: r.name, sub: `${r.capacity} places`, items: items.filter((i) => i.roomId === r.id) }))
      : view === "instructor"
        ? [...new Map(items.filter((i) => i.type !== "rental").map((i) => [i.instructorId!, i.instructorName!])).entries()]
            .sort((a, b) => a[1].localeCompare(b[1], "fr"))
            .map(([id, name]) => ({ key: id, name, sub: "", items: items.filter((i) => i.type !== "rental" && i.instructorId === id) }))
        : [...new Map(items.filter((i) => i.type !== "rental").map((i) => [i.groupId!, i.groupName!])).entries()]
            .sort((a, b) => a[1].localeCompare(b[1], "fr"))
            .map(([id, name]) => ({ key: id, name, sub: "", items: items.filter((i) => i.type !== "rental" && i.groupId === id) }));
  const conflictRows = rows.filter((r) => overlapping(r.items).size > 0);

  const position = (i: PlanningItem) => {
    const start = Math.max(open, minutesOf(localParts(i.startsAt).time));
    const end = Math.min(close, minutesOf(localParts(i.endsAt).time) || close);
    return { left: `${((start - open) / span) * 100}%`, width: `${(Math.max(15, end - start) / span) * 100}%` };
  };
  const label = (i: PlanningItem) =>
    i.type === "rental"
      ? (i.renterName ?? "")
      : view === "room"
        ? `${i.groupName} · ${i.instructorName}`
        : view === "instructor"
          ? `${i.groupName}${i.roomName ? ` · ${i.roomName}` : ""}`
          : `${i.roomName ?? "sans salle"} · ${i.instructorName}`;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  const blockClass = (i: PlanningItem, clash: Set<string>) =>
    clash.has(`${i.type}${i.id}`) ? "blk blk-conflict" : i.type === "rental" ? "blk blk-rental" : i.type === "training" ? "blk blk-training" : "blk blk-course";
  const openItem = (i: PlanningItem) => {
    if (i.type === "rental") navigate(`/locations/${i.rentalId}`);
    else if (can("groups:write") && i.sheetStatus !== "validated") setMoving(i);
    else navigate(`/presences/${i.id}`);
  };
  /** Week and month views show every item; a conflict is two items of the same room at the same time. */
  const calendarClash = (() => {
    const ids = new Set<string>();
    const byRoom = new Map<string, PlanningItem[]>();
    for (const i of allItems) if (i.roomId) byRoom.set(i.roomId, [...(byRoom.get(i.roomId) ?? []), i]);
    for (const list of byRoom.values()) for (const k of overlapping(list)) ids.add(k);
    return ids;
  })();
  const calendarLabel = (i: PlanningItem) => (i.type === "rental" ? (i.renterName ?? "Location") : `${i.groupName}${i.roomName ? ` · ${i.roomName}` : ""}`);

  return (
    <>
      <PageHeader
        title="Planning global"
        subtitle={period === "day" ? `${weekdayLabel(weekday)} ${frDate(date)}` : periodTitle(period, date)}
        actions={
          <>
            <Segmented
              label="Période"
              value={period}
              onChange={(v) => update({ periode: v })}
              options={[
                { value: "day", label: "Jour" },
                { value: "week", label: "Semaine" },
                { value: "month", label: "Mois" },
              ]}
            />
            {period === "day" ? <span className="lab">Vue par</span> : null}
            {period === "day" ? (
              <Segmented
                label="Vue par"
                value={view}
                onChange={(v) => update({ vue: v })}
                options={[
                  { value: "room", label: "Salle" },
                  { value: "instructor", label: "Prof / Formateur" },
                  { value: "group", label: "Groupe" },
                ]}
              />
            ) : null}
            <button type="button" className="btn btn-g" aria-label="Période précédente" onClick={() => update({ date: shiftPeriod(period, date, -1) })}>
              ‹
            </button>
            <input className="input" type="date" aria-label="Date" value={date} onChange={(e) => e.target.value && update({ date: e.target.value })} />
            <button type="button" className="btn btn-g" aria-label="Période suivante" onClick={() => update({ date: shiftPeriod(period, date, 1) })}>
              ›
            </button>
            <button type="button" className="btn" onClick={() => window.print()}>
              Imprimer
            </button>
          </>
        }
      />
      {period === "day" && conflictRows.length ? (
        <div className="ban ban-red" role="alert">
          <strong>{conflictRows.length} conflit(s) détecté(s)</strong>
          <span>{conflictRows.map((r) => r.name).join(", ")} : des créneaux se chevauchent.</span>
        </div>
      ) : null}
      <div className="row center" style={{ gap: 10 }}>
        <span className="lab">Légende</span>
        <Badge tone="blue">Cours</Badge>
        <Badge tone="teal">Formation</Badge>
        <Badge tone="orange">Location</Badge>
        <Badge tone="red">Conflit</Badge>
        <span className="cap" style={{ marginInlineStart: 12 }}>
          {can("groups:write")
            ? "Cliquez sur une séance pour la déplacer : le conflit est vérifié avant validation."
            : "Cliquez sur une séance pour ouvrir sa feuille de présence."}
        </span>
      </div>
      <Card>
        <ErrorBanner error={planning.error ?? rooms.error ?? centre.error} retry={() => planning.refetch()} />
        {planning.isPending || rooms.isPending ? (
          <Loading />
        ) : period === "week" ? (
          <WeekView
            date={date}
            items={allItems}
            clash={calendarClash}
            open={open}
            close={close}
            label={calendarLabel}
            blockClass={(i) => blockClass(i, calendarClash)}
            onOpen={openItem}
            onDay={(d) => update({ date: d, periode: "day" })}
          />
        ) : period === "month" ? (
          <MonthView
            date={date}
            items={allItems}
            clash={calendarClash}
            open={open}
            close={close}
            label={calendarLabel}
            blockClass={(i) => blockClass(i, calendarClash)}
            onOpen={openItem}
            onDay={(d) => update({ date: d, periode: "day" })}
          />
        ) : rows.length === 0 ? (
          <Empty title="Rien de planifié ce jour" />
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
              {rows.map((r) => {
                const clash = overlapping(r.items);
                return (
                  <div key={r.key} style={{ display: "grid", gridTemplateColumns: "150px 1fr", borderTop: "1px solid var(--line)" }}>
                    <div style={{ padding: "8px 4px" }}>
                      <strong>{r.name}</strong>
                      {r.sub ? <div className="cap">{r.sub}</div> : null}
                    </div>
                    <div className="timeline-row" style={{ borderTop: 0 }}>
                      {r.items.map((i) => {
                        const k = `${i.type}${i.id}`;
                        const cls = blockClass(i, clash);
                        return (
                          <button
                            key={k}
                            type="button"
                            className={cls}
                            style={position(i)}
                            title={`${TYPE_LABEL[i.type]} ${frTime(i.startsAt)}-${frTime(i.endsAt)} · ${label(i)}`}
                            onClick={() => openItem(i)}
                          >
                            <div style={{ fontWeight: 600 }}>{label(i)}</div>
                            <div>
                              {clash.has(k) ? "Conflit · " : ""}
                              {frTime(i.startsAt)}-{frTime(i.endsAt)}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Card>
      {moving ? <MoveSessionModal item={moving} groupInstructorId={moving.instructorId ?? ""} onClose={() => setMoving(null)} /> : null}
    </>
  );
}
