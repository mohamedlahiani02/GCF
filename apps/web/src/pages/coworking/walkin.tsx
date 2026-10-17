import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import { useSession } from "../../auth/session";
import { useToast } from "../../components/toasts";
import { ErrorBanner, Field, Loading, Modal } from "../../components/ui";
import { errorMessage } from "../../lib/errors";
import { tnd, todayIso } from "../../lib/format";
import {
  CATEGORY,
  durationLabel,
  memberName,
  useFloors,
  useFormats,
  useResourceTypes,
  type Booking,
  type FloorState,
  type MemberRow,
  type Quote,
  type SlotsResponse,
} from "./api";
import { QuickBooking, isDeskBookable, quarterNow, useMemberCollect } from "./bookingParts";
import { MemberPicker } from "./memberPicker";

type Step = "client" | "seat" | "confirm" | "done";

interface Seat {
  resource: { id: string; code: string; typeId: string };
  formatId: string;
  startTime: string;
  durationMinutes: number | null;
}

/** Step 2: type, format and slot of today, then a resource free over that slot on any floor. */
function SeatStep({ onPick }: { onPick: (seat: Seat) => void }) {
  const types = useResourceTypes();
  const formats = useFormats();
  const floors = useFloors();
  const date = todayIso();
  const now = quarterNow().time;
  const sellable = (formats.data ?? []).filter((f) => f.prices.length > 0);
  const bookableTypes = (types.data ?? []).filter(
    (t) => t.status === "active" && isDeskBookable({ category: t.category, status: "active" }) && sellable.some((f) => f.typeId === t.id),
  );
  const [typeId, setTypeId] = useState("");
  const type = bookableTypes.find((t) => t.id === typeId) ?? bookableTypes[0];
  const typeFormats = sellable.filter((f) => f.typeId === type?.id);
  const [formatId, setFormatId] = useState("");
  const format = typeFormats.find((f) => f.id === formatId) ?? typeFormats[0];
  const durations: number[] = [];
  if (format?.nature === "free" && format.minMinutes && format.maxMinutes && format.startStepMinutes) {
    for (let m = format.minMinutes; m <= format.maxMinutes; m += format.startStepMinutes) durations.push(m);
  }
  const [duration, setDuration] = useState<number | null>(null);
  const minutes = format?.nature === "free" ? (duration ?? format.minMinutes ?? undefined) : undefined;
  const slots = useQuery({
    queryKey: ["cw-slots", format?.id, date, minutes],
    queryFn: () => api.get<SlotsResponse>(`/coworking/formats/${format!.id}/slots`, { date, durationMinutes: minutes }),
    enabled: !!format,
  });
  const open = (slots.data?.slots ?? []).filter((s) => new Date(s.endsAt).getTime() > Date.now());
  const [startTime, setStartTime] = useState("");
  const current = open.filter((s) => s.startTime <= now).at(-1) ?? open[0];
  const slot = open.find((s) => s.startTime === startTime) ?? current;
  const free = useQuery({
    queryKey: ["cw-walkin-free", type?.id, date, slot?.startTime, slot?.endTime, floors.data?.map((f) => f.id)],
    queryFn: async () => {
      const states = await Promise.all(
        floors.data!.map((f) => api.get<FloorState>(`/coworking/floors/${f.id}/state`, { date, startTime: slot!.startTime, endTime: slot!.endTime })),
      );
      return states.flatMap((s) =>
        s.resources.filter((r) => r.typeId === type!.id && r.state === "free" && r.status === "active").map((r) => ({ ...r, floorName: s.floor.name })),
      );
    },
    enabled: !!type && !!slot && !!floors.data?.length,
    staleTime: 0,
  });

  if (types.isPending || formats.isPending || floors.isPending) return <Loading />;
  if (!bookableTypes.length) {
    return (
      <div className="ban ban-amber">
        <span>Aucun type de ressource réservable avec un format tarifé : configurez-les dans les paramètres coworking.</span>
      </div>
    );
  }
  const pick = (resource: { resourceId: string; code: string; typeId: string }) =>
    onPick({
      resource: { id: resource.resourceId, code: resource.code, typeId: resource.typeId },
      formatId: format!.id,
      startTime: slot!.startTime,
      durationMinutes: minutes ?? null,
    });
  return (
    <div className="stack">
      <div className="grid2">
        <Field label="Type de ressource">
          <select className="input" value={type?.id ?? ""} onChange={(e) => (setTypeId(e.target.value), setFormatId(""), setStartTime(""), setDuration(null))}>
            {bookableTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({CATEGORY[t.category]})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Format">
          <select className="input" value={format?.id ?? ""} onChange={(e) => (setFormatId(e.target.value), setStartTime(""), setDuration(null))}>
            {typeFormats.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </Field>
        {durations.length ? (
          <Field label="Durée">
            <select className="input" value={minutes ?? ""} onChange={(e) => setDuration(Number(e.target.value))}>
              {durations.map((d) => (
                <option key={d} value={d}>
                  {durationLabel(d)}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field
          label="Créneau d'aujourd'hui"
          error={slots.data && !open.length ? (slots.data.open ? "Plus aucun créneau aujourd'hui" : "Fermé aujourd'hui") : null}
        >
          <select className="input" value={slot?.startTime ?? ""} disabled={!open.length} onChange={(e) => setStartTime(e.target.value)}>
            {open.map((s) => (
              <option key={s.startTime} value={s.startTime}>
                {s.startTime}-{s.endTime} ({s.free} libre(s))
              </option>
            ))}
          </select>
        </Field>
      </div>
      <ErrorBanner error={slots.error ?? free.error} />
      <div>
        <div className="lab" style={{ marginBottom: 6 }}>
          Ressources libres
        </div>
        {free.isPending && slot ? (
          <span className="cap">Recherche des ressources libres…</span>
        ) : free.data?.length ? (
          <div className="cw-seat-list" role="list" aria-label="Ressources libres">
            {free.data.map((r, i) => (
              <button key={r.resourceId} type="button" role="listitem" className="btn" autoFocus={i === 0} onClick={() => pick(r)}>
                <strong>{r.code}</strong>
                <span className="cap">{r.floorName}</span>
              </button>
            ))}
          </div>
        ) : slot ? (
          <span className="cap">Aucune ressource de ce type n'est libre sur ce créneau.</span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Top-bar entry point of the walk-in desk flow, keyboard first: find or create the client (Enter takes the first
 * match), pick a free seat now, confirm the quote (a slot already started may be overridden), then take the payment
 * in the collect drawer, after which the arrival is recorded automatically.
 */
export function WalkInButton() {
  const { can } = useSession();
  const [step, setStep] = useState<Step | null>(null);
  const [member, setMember] = useState<MemberRow | null>(null);
  const [seat, setSeat] = useState<Seat | null>(null);
  const [booking, setBooking] = useState<(Booking & { quote: Quote }) | null>(null);
  const collect = useMemberCollect();
  const client = useQueryClient();
  const toast = useToast();
  const checkIn = useMutation({
    mutationFn: (id: string) => api.post<Booking>(`/coworking/bookings/${id}/check-in`),
    onSuccess: async (b) => {
      await client.invalidateQueries();
      toast(`Arrivée de ${b.memberName} enregistrée sur ${b.resourceCode}.`);
    },
    onError: (error) => toast(errorMessage(error), "error"),
  });
  const reset = () => {
    setStep(null);
    setMember(null);
    setSeat(null);
    setBooking(null);
  };
  const steps: { key: Step; label: string }[] = [
    { key: "client", label: "1. Client" },
    { key: "seat", label: "2. Place" },
    { key: "confirm", label: "3. Prix" },
    { key: "done", label: "4. Paiement" },
  ];
  const finish = (pay: boolean) => {
    const b = booking!;
    reset();
    if (pay) collect.open(b.memberId!, () => checkIn.mutate(b.id));
    else checkIn.mutate(b.id);
  };

  return (
    <>
      <button type="button" className="btn" onClick={() => setStep("client")}>
        + Accueil coworking
      </button>
      {step ? (
        <Modal
          title="Accueil d'un client coworking"
          wide
          onClose={reset}
          footer={
            <>
              <span className="cap">Échap pour fermer</span>
              <div className="row" style={{ gap: 8 }}>
                {step === "seat" || step === "confirm" ? (
                  <button type="button" className="btn" onClick={() => setStep(step === "seat" ? "client" : "seat")}>
                    Retour
                  </button>
                ) : null}
                <button type="button" className="btn" onClick={reset}>
                  {step === "done" ? "Fermer" : "Annuler"}
                </button>
              </div>
            </>
          }
        >
          <ol className="cw-steps" aria-label="Étapes">
            {steps.map((s) => (
              <li key={s.key} aria-current={s.key === step ? "step" : undefined}>
                {s.label}
              </li>
            ))}
          </ol>
          {step === "client" ? (
            <MemberPicker
              autoFocus
              onPick={(m) => {
                setMember(m);
                setStep("seat");
              }}
            />
          ) : null}
          {member && step !== "client" ? (
            <div>
              <span className="lab">Client </span>
              <strong>{memberName(member)}</strong>
              {member.phone ? <span className="cap"> · {member.phone}</span> : null}
            </div>
          ) : null}
          {step === "seat" ? (
            <SeatStep
              onPick={(s) => {
                setSeat(s);
                setStep("confirm");
              }}
            />
          ) : null}
          {step === "confirm" && member && seat ? (
            <QuickBooking
              resource={seat.resource}
              date={todayIso()}
              time={seat.startTime}
              member={member}
              initial={{ formatId: seat.formatId, startTime: seat.startTime, durationMinutes: seat.durationMinutes }}
              onCreated={(b) => {
                setBooking(b);
                if (b.charge > 0 && can("payments:write")) setStep("done");
                else {
                  reset();
                  checkIn.mutate(b.id);
                }
              }}
            />
          ) : null}
          {step === "done" && booking ? (
            <div className="stack">
              <div className="ban ban-green" role="status">
                <strong>Réservation enregistrée</strong>
                <span>
                  {booking.resourceCode}, {booking.startTime}-{booking.endTime} · {tnd(booking.charge)} TND à régler
                </span>
              </div>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="btn btn-p btn-l" autoFocus onClick={() => finish(true)}>
                  Encaisser {tnd(booking.charge)} TND puis enregistrer l'arrivée
                </button>
                <button type="button" className="btn btn-l" onClick={() => finish(false)}>
                  Enregistrer l'arrivée sans encaisser
                </button>
              </div>
            </div>
          ) : null}
        </Modal>
      ) : null}
      {collect.element}
    </>
  );
}
