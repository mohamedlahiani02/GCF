import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ZoomableFloorPlan } from "../../components/zoomable-floor-plan";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { useSession } from "../../auth/session";
import { useToast } from "../../components/toasts";
import { ErrorBanner, Field, Loading, Modal, Tabs } from "../../components/ui";
import { errorMessage } from "../../lib/errors";
import { tnd, todayIso } from "../../lib/format";
import {
  CATEGORY,
  PLAN_STATE,
  floorImage,
  useFloorDetail,
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
import { QuickBooking, isDeskBookable, quarterNow, useBookableFormat, useMemberCollect } from "./bookingParts";
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
  const bookable = useBookableFormat(typeFormats, date);
  const format = typeFormats.find((f) => f.id === (formatId || bookable)) ?? typeFormats[0];
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
      return states;
    },
    enabled: !!type && !!slot && !!floors.data?.length,
    staleTime: 0,
    refetchInterval: 30_000,
  });

  const [chosenFloor, setChosenFloor] = useState<string | null>(null);
  const canPick = (r: FloorState["resources"][number]) => r.typeId === type?.id && r.state === "free" && r.status === "active";
  const states = free.data ?? [];
  const activeFloor = states.find((s) => s.floor.id === chosenFloor) ?? states.find((s) => s.resources.some(canPick)) ?? states[0];
  const floor = useFloorDetail(activeFloor?.floor.id ?? null);
  const resources = new Map(activeFloor?.resources.map((r) => [r.resourceId, r]) ?? []);
  const placed = new Set(floor.data?.layout.items.map((i) => i.resourceId) ?? []);
  const unplaced = activeFloor?.resources.filter((r) => canPick(r) && !placed.has(r.resourceId)).length ?? 0;
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
                {t.name === CATEGORY[t.category] ? t.name : `${t.name} (${CATEGORY[t.category]})`}
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
      <ErrorBanner error={types.error ?? formats.error ?? floors.error ?? slots.error ?? free.error ?? floor.error} retry={() => free.refetch()} />
      {slot ? (
        <section className="cw-walkin-plan stack" aria-label="Choisir une place sur le plan">
          <div>
            <strong>Choisissez la place directement sur le plan</strong>
            <p className="cap">
              {slot.startTime}–{slot.endTime} · Les places du type choisi, libres sur tout le créneau, sont sélectionnables. Cliquez sur une place pour
              continuer vers le prix.
            </p>
          </div>
          {free.isPending ? (
            <Loading />
          ) : (
            <>
              <Tabs
                value={activeFloor?.floor.id ?? ""}
                onChange={setChosenFloor}
                tabs={states.map((s) => ({ value: s.floor.id, label: `${s.floor.name} (${s.resources.filter(canPick).length} libres)` }))}
              />
              <div className="fp-legend" aria-label="Légende des places">
                <span>
                  <i className="free" aria-hidden="true" />
                  Libre et sélectionnable
                </span>
                <span>Autres places : indisponibles ou d’un autre type</span>
              </div>
              {!activeFloor ? (
                <p className="cap">Aucun étage actif avec un plan disponible. Configurez les étages dans les paramètres coworking.</p>
              ) : floor.isPending ? (
                <Loading />
              ) : floor.data && floor.data.layout.items.length ? (
                <ZoomableFloorPlan
                  key={floor.data.id}
                  layout={floor.data.layout}
                  image={floorImage(floor.data)}
                  zones={floor.data.zones}
                  title={`Choisir une place — ${floor.data.name}`}
                  onSelect={(id) => {
                    const r = resources.get(id);
                    if (r && canPick(r) && !free.isFetching) pick(r);
                  }}
                  appearance={(id) => {
                    const r = resources.get(id);
                    if (!r) return undefined;
                    const selectable = canPick(r) && !free.isFetching;
                    return {
                      label: r.code,
                      title: `${r.code}, ${r.typeName} : ${selectable ? "libre, choisir cette place" : r.typeId !== type?.id ? "autre type de ressource" : PLAN_STATE[r.state]}`,
                      state: r.state,
                      disabled: !selectable,
                      category: r.category,
                      capacity: r.capacity,
                    };
                  }}
                />
              ) : floor.isError ? null : (
                <div className="ban ban-amber">
                  <span>
                    Le plan de cet étage n’est pas encore configuré. Placez les ressources sur le plan dans les paramètres coworking pour permettre la sélection
                    visuelle.
                  </span>
                </div>
              )}
              {!activeFloor?.resources.some(canPick) ? (
                <p className="cap">Aucune place de ce type n’est disponible à cet étage pour ce créneau. Essayez un autre étage ou créneau.</p>
              ) : null}
              {unplaced > 0 && floor.isSuccess ? (
                <p className="cap">
                  {unplaced} place(s) libre(s) ne sont pas encore positionnées sur ce plan. Leur emplacement doit être configuré avant la sélection.
                </p>
              ) : null}
              {free.isFetching ? (
                <p className="cap" role="status">
                  Actualisation des disponibilités…
                </p>
              ) : null}
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}

/**
 * Top-bar entry point of the walk-in desk flow, keyboard first: find or create the client (Enter takes the first
 * match), pick a free seat now, confirm the quote (a slot already started may be overridden), then take the payment
 * in the collect drawer, after which the arrival is recorded automatically.
 */
/**
 * Desk wizard for a client walking in. The caller owns the trigger and keeps the wizard mounted, so the collect drawer
 * and the arrival opened at the last step outlive the dialog.
 */
export function WalkInWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { can } = useSession();
  const [step, setStep] = useState<Step | null>(null);
  useEffect(() => {
    if (open) setStep("client");
  }, [open]);
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
    onClose();
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
          {member && step === "seat" ? (
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
