import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api/client";
import type { Installment, Room } from "../api/types";
import { useSession } from "../auth/session";
import { usePage, useCollect } from "../components/shell";
import { useToast } from "../components/toasts";
import {
  Badge,
  Card,
  ConflictBanner,
  Empty,
  ErrorBanner,
  Field,
  Kpi,
  Loading,
  Modal,
  PageHeader,
  ReasonDialog,
  Segmented,
  StateBadge,
  Tabs,
} from "../components/ui";
import { conflictsOf } from "../lib/errors";
import { addDaysIso, frDate, frTime, localParts, todayIso, tryParseTnd, tnd, weekdayLabel } from "../lib/format";
import { RENTAL_UNIT } from "../lib/labels";
import type { PlanningItem } from "./groups";

type Unit = "hour" | "half_day" | "day" | "month" | "year";
const UNITS: Unit[] = ["hour", "half_day", "day", "month", "year"];
const PAYMENT: Record<string, string> = {
  full: "Totalité à la réservation",
  deposit_balance: "Acompte puis solde le premier jour",
  recurring: "Une échéance par période",
};

interface Renter {
  id: string;
  name: string;
  company: string | null;
  phone: string | null;
  email: string | null;
}
interface RentalRow {
  id: string;
  renterName: string;
  roomName: string;
  unit: Unit;
  quantity: number;
  total: number;
  paymentMode: string;
  status: "active" | "cancelled";
  firstStart: string | null;
  lastEnd: string | null;
  slots: number | null;
}
interface RentalDetail {
  id: string;
  renterId: string;
  renterName: string;
  company: string | null;
  roomId: string;
  roomName: string;
  unit: Unit;
  quantity: number;
  unitPrice: number;
  total: number;
  paymentMode: string;
  status: "active" | "cancelled";
  cancelReason: string | null;
  notes: string | null;
  slots: { id: string; startsAt: string; endsAt: string }[];
  schedule: Installment[];
  receipts: { id: string; number: string; issuedAt: string }[];
  renterTotals: { due: number; credit: number };
}
interface Centre {
  openWeekdays: number[];
}

const blockClass = (type: PlanningItem["type"]) => (type === "rental" ? "blk blk-rental" : type === "training" ? "blk blk-training" : "blk blk-course");
const quantityLabel = (unit: Unit, quantity: number) =>
  unit === "hour" ? `${Math.floor(quantity / 60)} h${quantity % 60 ? ` ${quantity % 60} min` : ""}` : `${quantity} × ${RENTAL_UNIT[unit]?.toLowerCase()}`;

/** Monday of the week that contains the date. */
function weekStart(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  return addDaysIso(date, 1 - day);
}

/* Weekly room calendar */

function RoomCalendar({ rooms }: { rooms: Room[] }) {
  const navigate = useNavigate();
  const [monday, setMonday] = useState(weekStart(todayIso()));
  const centre = useQuery({ queryKey: ["centre-settings"], queryFn: () => api.get<Centre>("/centre") });
  const days = (centre.data?.openWeekdays ?? [1, 2, 3, 4, 5, 6])
    .slice()
    .sort()
    .map((d) => addDaysIso(monday, d - 1));
  const planning = useQuery({
    queryKey: ["planning", monday, addDaysIso(monday, 6)],
    queryFn: () => api.get<{ items: PlanningItem[] }>("/planning", { from: monday, to: addDaysIso(monday, 6) }),
  });
  const items = planning.data?.items ?? [];
  return (
    <Card
      title={
        <div className="row center" style={{ gap: 10 }}>
          <span className="lab">Légende</span>
          <Badge tone="blue">Cours</Badge>
          <Badge tone="teal">Formation</Badge>
          <Badge tone="orange">Louée</Badge>
          <span className="cap">
            Semaine du {frDate(monday)} au {frDate(addDaysIso(monday, 6))}
          </span>
        </div>
      }
      actions={
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn btn-g" aria-label="Semaine précédente" onClick={() => setMonday(addDaysIso(monday, -7))}>
            ‹
          </button>
          <button type="button" className="btn btn-g" onClick={() => setMonday(weekStart(todayIso()))}>
            Cette semaine
          </button>
          <button type="button" className="btn btn-g" aria-label="Semaine suivante" onClick={() => setMonday(addDaysIso(monday, 7))}>
            ›
          </button>
        </div>
      }
    >
      <ErrorBanner error={planning.error} />
      <div className="xs">
        <table className="tbl" style={{ tableLayout: "fixed", minWidth: 960 }}>
          <thead>
            <tr>
              <th style={{ width: 150 }}>Salle</th>
              {days.map((d) => (
                <th key={d}>
                  {weekdayLabel(new Date(`${d}T00:00:00Z`).getUTCDay() || 7)} {d.slice(8, 10)}/{d.slice(5, 7)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rooms.map((r) => (
              <tr key={r.id}>
                <td style={{ verticalAlign: "top" }}>
                  <strong>{r.name}</strong>
                  <div className="cap">{r.capacity} places</div>
                </td>
                {days.map((d) => {
                  const own = items.filter((i) => i.roomId === r.id && localParts(i.startsAt).date === d);
                  return (
                    <td key={d} style={{ verticalAlign: "top" }}>
                      <div className="stack" style={{ gap: 4 }}>
                        {own.map((i) => (
                          <button
                            key={`${i.type}${i.id}`}
                            type="button"
                            className={blockClass(i.type)}
                            onClick={() => navigate(i.type === "rental" ? `/locations/${i.rentalId}` : `/groupes/${i.groupId}`)}
                          >
                            <div>
                              {frTime(i.startsAt)}-{frTime(i.endsAt)}
                            </div>
                            <div style={{ fontWeight: 600 }}>{i.type === "rental" ? i.renterName : i.groupName}</div>
                          </button>
                        ))}
                        {own.length === 0 ? <span className="cap">Libre</span> : null}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* Rooms and tariffs */

function RoomModal({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [capacity, setCapacity] = useState("");
  const [equipment, setEquipment] = useState("");
  const create = useMutation({
    mutationFn: () => api.post("/catalogue/rooms", { name: name.trim(), capacity: Number(capacity), equipment: equipment.trim() }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["rooms"] });
      toast("Salle créée.");
      onClose();
    },
  });
  return (
    <Modal
      title="Nouvelle salle"
      onClose={onClose}
      footer={
        <>
          <span />
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!name.trim() || !(Number(capacity) >= 1) || create.isPending} onClick={() => create.mutate()}>
              Créer
            </button>
          </div>
        </>
      }
    >
      <Field label="Nom *">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Capacité *">
        <input className="input num" type="number" min={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
      </Field>
      <Field label="Équipements">
        <input className="input" value={equipment} onChange={(e) => setEquipment(e.target.value)} />
      </Field>
      <ErrorBanner error={create.error} />
    </Modal>
  );
}

function RatesModal({ room, rates, onClose }: { room: Room; rates: { unit: Unit; amount: number }[]; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [texts, setTexts] = useState<Record<Unit, string>>(
    Object.fromEntries(UNITS.map((u) => [u, rates.find((r) => r.unit === u) ? tnd(rates.find((r) => r.unit === u)!.amount) : ""])) as Record<Unit, string>,
  );
  const parsed = UNITS.map((u) => ({ unit: u, text: texts[u].trim(), amount: tryParseTnd(texts[u]) }));
  const invalid = parsed.some((p) => p.text !== "" && (p.amount === null || p.amount < 0));
  const save = useMutation({
    mutationFn: () => api.put(`/rooms/${room.id}/rates`, { rates: parsed.filter((p) => p.text !== "").map((p) => ({ unit: p.unit, amount: p.amount })) }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["room-rates"] });
      toast("Tarifs enregistrés. Ils s'appliquent aux nouvelles locations.");
      onClose();
    },
  });
  return (
    <Modal
      title={`Tarifs de ${room.name}`}
      onClose={onClose}
      footer={
        <>
          <span className="cap">Laisser vide : durée non proposée à la location</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={invalid || save.isPending} onClick={() => save.mutate()}>
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <div className="grid2">
        {UNITS.map((u) => (
          <Field key={u} label={`${RENTAL_UNIT[u]} (TND)`} error={texts[u].trim() && tryParseTnd(texts[u]) === null ? "Montant invalide" : null}>
            <input className="input num" inputMode="decimal" value={texts[u]} onChange={(e) => setTexts({ ...texts, [u]: e.target.value })} />
          </Field>
        ))}
      </div>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

function RoomsTable({ rooms }: { rooms: Room[] }) {
  const { can } = useSession();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Room | null>(null);
  const rates = useQuery({
    queryKey: ["room-rates", rooms.map((r) => r.id).join(",")],
    queryFn: async () =>
      Object.fromEntries(await Promise.all(rooms.map(async (r) => [r.id, await api.get<{ unit: Unit; amount: number }[]>(`/rooms/${r.id}/rates`)] as const))),
    enabled: rooms.length > 0,
  });
  const rate = (roomId: string, unit: Unit) => rates.data?.[roomId]?.find((r) => r.unit === unit)?.amount;
  return (
    <Card
      title="Salles"
      actions={
        can("rooms:write") ? (
          <button type="button" className="btn" onClick={() => setCreating(true)}>
            + Salle
          </button>
        ) : null
      }
    >
      <ErrorBanner error={rates.error} />
      {rooms.length === 0 ? (
        <Empty title="Aucune salle" />
      ) : (
        <div className="xs">
          <table className="tbl">
            <thead>
              <tr>
                <th>Salle</th>
                <th className="num">Capacité</th>
                <th>Équipements</th>
                {UNITS.map((u) => (
                  <th key={u} className="num">
                    {RENTAL_UNIT[u]}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rooms.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.name} {r.status !== "active" ? <Badge tone="gray">Archivée</Badge> : null}
                  </td>
                  <td className="num">{r.capacity}</td>
                  <td>{r.equipment ?? ""}</td>
                  {UNITS.map((u) => (
                    <td key={u} className="num">
                      {rate(r.id, u) === undefined ? "-" : tnd(rate(r.id, u))}
                    </td>
                  ))}
                  <td style={{ textAlign: "right" }}>
                    {can("catalogue:write") && rates.data ? (
                      <button type="button" className="btn btn-g" onClick={() => setEditing(r)}>
                        Tarifs
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating ? <RoomModal onClose={() => setCreating(false)} /> : null}
      {editing ? <RatesModal room={editing} rates={rates.data?.[editing.id] ?? []} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

function RenterModal({ renter, onClose, onSaved }: { renter: Renter | null; onClose: () => void; onSaved?: (r: Renter) => void }) {
  const client = useQueryClient();
  const [name, setName] = useState(renter?.name ?? "");
  const [company, setCompany] = useState(renter?.company ?? "");
  const [phone, setPhone] = useState(renter?.phone ?? "");
  const [email, setEmail] = useState(renter?.email ?? "");
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), company: company.trim(), phone: phone.trim(), email: email.trim() };
      return renter ? api.patch<Renter>(`/renters/${renter.id}`, body) : api.post<Renter>("/renters", body);
    },
    onSuccess: async (r) => {
      await client.invalidateQueries({ queryKey: ["renters"] });
      onSaved?.(r);
      onClose();
    },
  });
  return (
    <Modal
      title={renter ? "Modifier le loueur" : "Nouveau loueur"}
      onClose={onClose}
      footer={
        <>
          <span />
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <Field label="Nom *">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Société ou association">
        <input className="input" value={company} onChange={(e) => setCompany(e.target.value)} />
      </Field>
      <div className="grid2">
        <Field label="Téléphone">
          <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="E-mail">
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      </div>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

export function RoomsPage() {
  usePage(["Salles et locations"]);
  const { can } = useSession();
  const navigate = useNavigate();
  const collect = useCollect();
  const [tab, setTab] = useState<"calendar" | "rooms" | "rentals" | "renters">("calendar");
  const [renter, setRenter] = useState<Renter | "new" | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);
  const rooms = useQuery({ queryKey: ["rooms"], queryFn: () => api.get<Room[]>("/catalogue/rooms") });
  const rentals = useQuery({
    queryKey: ["rentals", showCancelled],
    queryFn: () => api.get<RentalRow[]>("/rentals", { status: showCancelled ? "all" : "active" }),
    enabled: tab === "rentals",
  });
  const renters = useQuery({ queryKey: ["renters"], queryFn: () => api.get<Renter[]>("/renters"), enabled: tab === "renters" });
  const activeRooms = (rooms.data ?? []).filter((r) => r.status === "active");
  return (
    <>
      <PageHeader
        title="Salles et locations"
        actions={
          can("rooms:write") ? (
            <Link className="btn btn-p" to="/locations/nouvelle">
              + Nouvelle location
            </Link>
          ) : null
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "calendar", label: "Calendrier" },
          { value: "rooms", label: "Salles et tarifs" },
          { value: "rentals", label: "Locations" },
          { value: "renters", label: "Loueurs" },
        ]}
      />
      <ErrorBanner error={rooms.error} retry={() => rooms.refetch()} />
      {tab === "calendar" ? rooms.isPending ? <Loading /> : <RoomCalendar rooms={activeRooms} /> : null}
      {tab === "rooms" ? rooms.isPending ? <Loading /> : <RoomsTable rooms={rooms.data ?? []} /> : null}
      {tab === "rentals" ? (
        <Card
          title={
            <label className="row center" style={{ gap: 6 }}>
              <input type="checkbox" className="chk" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> Inclure les locations
              annulées
            </label>
          }
        >
          <ErrorBanner error={rentals.error} />
          {rentals.isPending ? (
            <Loading />
          ) : rentals.data?.length === 0 ? (
            <Empty title="Aucune location" />
          ) : (
            <div className="xs">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Loueur</th>
                    <th>Salle</th>
                    <th>Période</th>
                    <th>Durée</th>
                    <th className="num">Total (TND)</th>
                    <th>Statut</th>
                  </tr>
                </thead>
                <tbody>
                  {rentals.data?.map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => navigate(`/locations/${r.id}`)}>
                      <td>
                        <Link to={`/locations/${r.id}`} onClick={(e) => e.stopPropagation()}>
                          {r.renterName}
                        </Link>
                      </td>
                      <td>{r.roomName}</td>
                      <td>
                        {r.firstStart ? frDate(r.firstStart) : ""}
                        {r.lastEnd && r.firstStart && frDate(r.lastEnd) !== frDate(r.firstStart) ? ` au ${frDate(r.lastEnd)}` : ""}
                        <div className="cap">{r.slots ?? 0} créneau(x)</div>
                      </td>
                      <td>{quantityLabel(r.unit, r.quantity)}</td>
                      <td className="num">{tnd(r.total)}</td>
                      <td>{r.status === "active" ? <Badge tone="orange">Louée</Badge> : <Badge tone="gray">Annulée</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}
      {tab === "renters" ? (
        <Card
          title="Loueurs"
          actions={
            can("rooms:write") ? (
              <button type="button" className="btn" onClick={() => setRenter("new")}>
                + Loueur
              </button>
            ) : null
          }
        >
          <ErrorBanner error={renters.error} />
          {renters.data?.length === 0 ? (
            <Empty title="Aucun loueur" />
          ) : (
            <div className="xs">
              <table className="tbl">
                <tbody>
                  {renters.data?.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {r.name}
                        {r.company ? <div className="cap">{r.company}</div> : null}
                      </td>
                      <td>{[r.phone, r.email].filter(Boolean).join(" · ")}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        {can("payments:write") ? (
                          <button type="button" className="btn btn-g" onClick={() => collect({ renterId: r.id })}>
                            Encaisser
                          </button>
                        ) : null}
                        {can("rooms:write") ? (
                          <button type="button" className="btn btn-g" onClick={() => setRenter(r)}>
                            Modifier
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {renter ? <RenterModal renter={renter === "new" ? null : renter} onClose={() => setRenter(null)} /> : null}
        </Card>
      ) : null}
    </>
  );
}

/* New rental */

interface Preview {
  pricing: { unitPrice: number; quantity: number; total: number };
  schedule: { label: string; amount: number; dueDate: string }[];
  slots: number;
  conflicts: { type: "room" | "instructor" | "group"; startsAt: string; endsAt: string; description?: string }[];
}

export function RentalWizardPage() {
  usePage(["Salles et locations", "Nouvelle location"]);
  const navigate = useNavigate();
  const toast = useToast();
  const renters = useQuery({ queryKey: ["renters"], queryFn: () => api.get<Renter[]>("/renters") });
  const rooms = useQuery({ queryKey: ["rooms"], queryFn: () => api.get<Room[]>("/catalogue/rooms") });
  const [renterId, setRenterId] = useState("");
  const [creatingRenter, setCreatingRenter] = useState(false);
  const [roomId, setRoomId] = useState("");
  const [unit, setUnit] = useState<Unit>("hour");
  const [mode, setMode] = useState<"once" | "weekly">("once");
  const [date, setDate] = useState(todayIso());
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(addDaysIso(todayIso(), 27));
  const [weekdays, setWeekdays] = useState<number[]>([6]);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("12:00");
  const [periods, setPeriods] = useState("1");
  const [paymentMode, setPaymentMode] = useState<"full" | "deposit_balance" | "recurring">("full");
  const [depositText, setDepositText] = useState("");
  const [notes, setNotes] = useState("");
  const rates = useQuery({
    queryKey: ["room-rates-one", roomId],
    queryFn: () => api.get<{ unit: Unit; amount: number }[]>(`/rooms/${roomId}/rates`),
    enabled: !!roomId,
  });
  useEffect(() => {
    if (unit === "half_day") (setStartTime("08:00"), setEndTime("13:00"));
    if (unit === "day" || unit === "month" || unit === "year") (setStartTime("08:00"), setEndTime("20:00"));
    if (unit === "month" || unit === "year") setMode("weekly");
  }, [unit]);
  const deposit = depositText.trim() ? tryParseTnd(depositText) : null;
  const periodic = unit === "month" || unit === "year";
  const body =
    renterId && roomId && endTime > startTime && (mode === "once" ? !!date : !!from && !!to && to >= from && weekdays.length > 0)
      ? {
          renterId,
          roomId,
          unit,
          ...(periodic ? { periods: Math.max(1, Math.trunc(Number(periods) || 1)) } : {}),
          ...(mode === "once" ? { slots: [{ date, startTime, endTime }] } : { pattern: { from, to, weekdays: [...weekdays].sort(), startTime, endTime } }),
          paymentMode: periodic ? paymentMode : paymentMode === "recurring" ? "full" : paymentMode,
          ...(paymentMode === "deposit_balance" && deposit !== null ? { deposit } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        }
      : null;
  const [debounced, setDebounced] = useState(body);
  const key = JSON.stringify(body);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(JSON.parse(key) as typeof body), 300);
    return () => window.clearTimeout(t);
  }, [key]);
  const preview = useQuery({ queryKey: ["rental-preview", debounced], queryFn: () => api.post<Preview>("/rentals/preview", debounced), enabled: !!debounced });
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>("/rentals", body),
    onSuccess: (r) => {
      toast("Location enregistrée.");
      navigate(`/locations/${r.id}`);
    },
  });
  const hasRate = (u: Unit) => !!rates.data?.some((r) => r.unit === u);
  const conflicts = preview.data?.conflicts ?? [];
  return (
    <>
      <PageHeader title="Nouvelle location" />
      <div className="grid2" style={{ gridTemplateColumns: "2fr 1fr", alignItems: "start" }}>
        <Card
          title="Réservation"
          footer={
            <>
              <span className="cap">Le prix vient de la grille tarifaire de la salle</span>
              <button
                type="button"
                className="btn btn-p"
                disabled={!body || !preview.data || conflicts.length > 0 || (paymentMode === "deposit_balance" && deposit === null) || create.isPending}
                onClick={() => create.mutate()}
              >
                Confirmer la location
              </button>
            </>
          }
        >
          <div className="card-b stack">
            <div className="grid2">
              <Field label="Loueur *">
                <div className="input-with-action">
                  <select className="input" value={renterId} onChange={(e) => setRenterId(e.target.value)}>
                    <option value="">Choisir</option>
                    {(renters.data ?? []).map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                        {r.company ? ` (${r.company})` : ""}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="btn" aria-label="Nouveau loueur" onClick={() => setCreatingRenter(true)}>
                    +
                  </button>
                </div>
              </Field>
              <Field label="Salle *">
                <select className="input" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
                  <option value="">Choisir</option>
                  {(rooms.data ?? [])
                    .filter((r) => r.status === "active")
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} ({r.capacity} places)
                      </option>
                    ))}
                </select>
              </Field>
            </div>
            <div>
              <div className="lab" style={{ marginBottom: 6 }}>
                Tarif appliqué
              </div>
              <Segmented
                label="Unité de location"
                value={unit}
                onChange={setUnit}
                options={UNITS.map((u) => ({ value: u, label: RENTAL_UNIT[u] ?? u, disabled: !!roomId && rates.isSuccess && !hasRate(u) }))}
              />
              {roomId && rates.isSuccess && !hasRate(unit) ? <div className="err-text">Cette salle n'a pas de tarif pour cette durée.</div> : null}
            </div>
            {!periodic ? (
              <Segmented
                label="Fréquence"
                value={mode}
                onChange={setMode}
                options={[
                  { value: "once", label: "Une date" },
                  { value: "weekly", label: "Récurrente chaque semaine" },
                ]}
              />
            ) : null}
            {mode === "once" ? (
              <Field label="Date">
                <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
            ) : (
              <>
                <div className="grid2">
                  <Field label="Du">
                    <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                  </Field>
                  <Field label="Au">
                    <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                  </Field>
                </div>
                <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                  {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                    <label key={d} className="row center" style={{ gap: 6 }}>
                      <input
                        type="checkbox"
                        className="chk"
                        checked={weekdays.includes(d)}
                        onChange={(e) => setWeekdays(e.target.checked ? [...weekdays, d] : weekdays.filter((x) => x !== d))}
                      />
                      {weekdayLabel(d)}
                    </label>
                  ))}
                </div>
              </>
            )}
            <div className="grid3">
              <Field label="Début">
                <input className="input" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
              </Field>
              <Field label="Fin" error={endTime <= startTime ? "La fin doit suivre le début." : null}>
                <input className="input" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              </Field>
              {periodic ? (
                <Field label={unit === "month" ? "Nombre de mois" : "Nombre d'années"}>
                  <input className="input num" type="number" min={1} value={periods} onChange={(e) => setPeriods(e.target.value)} />
                </Field>
              ) : null}
            </div>
            <div>
              <div className="lab" style={{ marginBottom: 6 }}>
                Paiement
              </div>
              <Segmented
                label="Mode de paiement"
                value={paymentMode}
                onChange={setPaymentMode}
                options={[
                  { value: "full", label: "Totalité" },
                  { value: "deposit_balance", label: "Acompte et solde" },
                  { value: "recurring", label: "Par période", disabled: !periodic },
                ]}
              />
              <div className="cap" style={{ marginTop: 6 }}>
                {PAYMENT[paymentMode]}
              </div>
            </div>
            {paymentMode === "deposit_balance" ? (
              <Field label="Acompte (TND) *" error={depositText && deposit === null ? "Montant invalide" : null}>
                <input className="input num" inputMode="decimal" value={depositText} onChange={(e) => setDepositText(e.target.value)} />
              </Field>
            ) : null}
            <Field label="Notes">
              <textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            <ConflictBanner conflicts={conflicts} />
            {conflictsOf(create.error).length ? (
              <ConflictBanner conflicts={conflictsOf(create.error)} />
            ) : (
              <ErrorBanner error={create.error ?? preview.error} />
            )}
          </div>
        </Card>
        <Card title="Devis">
          <div className="card-b stack">
            {!preview.data ? (
              <span className="cap">Choisissez le loueur, la salle et les créneaux pour obtenir le prix.</span>
            ) : (
              <>
                <div>
                  <div className="lab">Créneaux</div>
                  <div>{preview.data.slots}</div>
                </div>
                <div>
                  <div className="lab">Tarif</div>
                  <div>
                    {tnd(preview.data.pricing.unitPrice)} TND / {RENTAL_UNIT[unit]?.toLowerCase()} · {quantityLabel(unit, preview.data.pricing.quantity)}
                  </div>
                </div>
                <div>
                  <div className="lab">Total</div>
                  <div className="amt-s num">{tnd(preview.data.pricing.total)} TND</div>
                </div>
                <table className="tbl">
                  <tbody>
                    {preview.data.schedule.map((l, i) => (
                      <tr key={i}>
                        <td>
                          {frDate(l.dueDate)} · {l.label}
                        </td>
                        <td className="num">{tnd(l.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {conflicts.length ? (
                  <Badge tone="red">{conflicts.length} conflit(s) de salle</Badge>
                ) : (
                  <Badge tone="green">Salle libre sur tous les créneaux</Badge>
                )}
              </>
            )}
          </div>
        </Card>
      </div>
      {creatingRenter ? <RenterModal renter={null} onClose={() => setCreatingRenter(false)} onSaved={(r) => setRenterId(r.id)} /> : null}
    </>
  );
}

/* Rental detail */

export function RentalPage() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const collect = useCollect();
  const client = useQueryClient();
  const toast = useToast();
  const [cancelling, setCancelling] = useState(false);
  const rental = useQuery({ queryKey: ["rental", id], queryFn: () => api.get<RentalDetail>(`/rentals/${id}`) });
  usePage(["Salles et locations", rental.data ? `Location : ${rental.data.renterName}` : "Location"]);
  if (rental.isPending) return <Loading />;
  if (rental.error) return <ErrorBanner error={rental.error} retry={() => rental.refetch()} />;
  const r = rental.data;
  const due = r.schedule.filter((i) => i.kind === "charge" && i.status === "open").reduce((s, i) => s + i.remaining, 0);
  return (
    <>
      <PageHeader
        title={`Location : ${r.renterName}`}
        subtitle={
          <span className="row center" style={{ gap: 8 }}>
            {r.status === "active" ? <Badge tone="orange">Louée</Badge> : <Badge tone="gray">Annulée</Badge>}
            <span>
              {r.roomName} · {quantityLabel(r.unit, r.quantity)} · {tnd(r.unitPrice)} TND / {RENTAL_UNIT[r.unit]?.toLowerCase()}
            </span>
            {r.company ? <span>· {r.company}</span> : null}
          </span>
        }
        actions={
          <>
            {can("payments:write") && r.status === "active" ? (
              <button type="button" className="btn btn-p" onClick={() => collect({ renterId: r.renterId })}>
                Encaisser
              </button>
            ) : null}
            <a className="btn" href={api.fileUrl(`/rentals/${id}/contract.pdf`)} target="_blank" rel="noreferrer">
              Devis / contrat PDF
            </a>
            {can("rooms:write") && r.status === "active" ? (
              <button type="button" className="btn btn-d" onClick={() => setCancelling(true)}>
                Annuler la location
              </button>
            ) : null}
          </>
        }
      />
      {r.cancelReason ? (
        <div className="ban ban-amber">
          <span>Annulée : {r.cancelReason}</span>
        </div>
      ) : null}
      <div className="grid4">
        <Kpi label="Total de la location" value={<span className="num">{tnd(r.total)}</span>} sub="TND" />
        <Kpi
          label="Reste à payer"
          value={<span className="num">{tnd(due)}</span>}
          sub="TND sur cette location"
          tone={r.schedule.some((i) => i.state === "overdue") ? "red" : undefined}
        />
        <Kpi label="Solde créditeur du loueur" value={<span className="num">{tnd(r.renterTotals.credit)}</span>} sub="TND" />
        <Kpi label="Créneaux" value={r.slots.length} />
      </div>
      <div className="grid2" style={{ alignItems: "start" }}>
        <Card title="Échéancier">
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Échéance</th>
                  <th className="num">Montant</th>
                  <th>Statut</th>
                </tr>
              </thead>
              <tbody>
                {r.schedule.map((i) => (
                  <tr key={i.id}>
                    <td>
                      {frDate(i.dueDate)} · {i.label}
                    </td>
                    <td className="num">{tnd(i.amount)}</td>
                    <td>
                      <StateBadge state={i.state} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Reste à payer</td>
                  <td className="num">{tnd(due)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          {r.receipts.length ? (
            <div className="card-b row" style={{ gap: 8, flexWrap: "wrap" }}>
              <span className="lab">Reçus liés</span>
              {r.receipts.map((x) => (
                <Link key={x.id} to={`/recus/${x.id}`}>
                  {x.number}
                </Link>
              ))}
            </div>
          ) : null}
        </Card>
        <Card title="Créneaux réservés">
          <div className="xs" style={{ maxHeight: 420, overflowY: "auto" }}>
            <table className="tbl">
              <tbody>
                {r.slots.map((s) => (
                  <tr key={s.id}>
                    <td>{frDate(s.startsAt)}</td>
                    <td>
                      {frTime(s.startsAt)}-{frTime(s.endsAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.notes ? <div className="card-b cap">{r.notes}</div> : null}
        </Card>
      </div>
      {cancelling ? (
        <ReasonDialog
          title="Annuler la location"
          danger
          explanation="Les créneaux à venir sont libérés et les échéances non payées annulées. Les sommes déjà reçues restent au crédit du loueur."
          confirmLabel="Annuler la location"
          onClose={() => setCancelling(false)}
          onConfirm={async (reason) => {
            await api.post(`/rentals/${id}/cancel`, { reason });
            await client.invalidateQueries();
            toast("Location annulée.");
          }}
        />
      ) : null}
    </>
  );
}
