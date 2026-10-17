import { isBookableCategory, type CwCategory } from "@gcf/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { api } from "../../api/client";
import { useSession } from "../../auth/session";
import { useToast } from "../../components/toasts";
import { Badge, ErrorBanner, Field, Loading, Modal, ReasonDialog } from "../../components/ui";
import { COWORKING_MESSAGES } from "../../lib/errors.coworking";
import { errorMessage } from "../../lib/errors";
import { frDate, frDateTime, localParts, tnd } from "../../lib/format";
import { CollectDrawer } from "../collect";
import {
  BOOKING_STATUS,
  CATEGORY,
  PROFILE,
  QUOTA,
  cancellationFee,
  durationLabel,
  fromMinutes,
  memberName,
  toMinutes,
  useFormats,
  useSettings,
  type Booking,
  type BookingDetail,
  type BookingInput,
  type MemberRow,
  type Quote,
  type SlotsResponse,
} from "./api";
import { MemberPicker } from "./memberPicker";

export function BookingStatusBadge({ status }: { status: Booking["status"] }) {
  const s = BOOKING_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** Opens the existing collect drawer for a coworking member; `onPaid` runs after the payment is saved. */
export function useMemberCollect() {
  const [payer, setPayer] = useState<{ memberId: string; onPaid: (() => void) | undefined } | null>(null);
  const element = payer ? <CollectDrawer payer={{ memberId: payer.memberId }} onClose={() => setPayer(null)} onPaid={payer.onPaid} /> : null;
  return { open: (memberId: string, onPaid?: () => void) => setPayer({ memberId, onPaid }), element };
}

/** Local time of the centre rounded down to the quarter hour. */
export function quarterNow(): { date: string; time: string } {
  const now = localParts(new Date());
  return { date: now.date, time: fromMinutes(Math.floor(toMinutes(now.time) / 15) * 15) };
}

/** Price breakdown of a quote, as the client will be charged. */
export function QuoteView({ quote }: { quote: Quote }) {
  return (
    <div className="card xs">
      <table className="tbl">
        <tbody>
          <tr>
            <td>
              {quote.format.label} · {frDate(quote.date)} {quote.startTime}-{quote.endTime}
              <div className="cap">
                Tarif {PROFILE[quote.profile].toLowerCase()}
                {quote.offpeak ? ", heures creuses" : ""} · {durationLabel(quote.minutes)}
              </div>
            </td>
            <td className="num">{tnd(quote.listPrice)}</td>
          </tr>
          {quote.coverage.sources.map((s) => (
            <tr key={`${s.kind}${s.id}`}>
              <td>
                Couvert par {s.kind === "subscription" ? "l'abonnement" : "le carnet"} {s.label}
                <div className="cap">
                  {QUOTA[s.quotaKind]} · {durationLabel(s.coveredMinutes)} couvertes
                </div>
              </td>
              <td className="num" />
            </tr>
          ))}
          {quote.coverage.discount > 0 ? (
            <tr>
              <td>Part couverte par les droits du client</td>
              <td className="num">-{tnd(quote.coverage.discount)}</td>
            </tr>
          ) : null}
          {quote.promotion ? (
            <tr>
              <td>Code promotionnel {quote.promotion.code}</td>
              <td className="num">-{tnd(quote.promotion.discount)}</td>
            </tr>
          ) : null}
        </tbody>
        <tfoot>
          <tr>
            <td>À payer</td>
            <td className="num">{tnd(quote.charge)} TND</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Portal limits the booking exceeds, with the explicit confirmation that the staff overrides them. */
function LimitWarnings({ quote, override, onOverride }: { quote: Quote; override: boolean; onOverride: (v: boolean) => void }) {
  if (!quote.warnings.length) return null;
  return (
    <div className="ban ban-amber" role="alert" style={{ flexDirection: "column", alignItems: "flex-start" }}>
      <strong>Limites du portail dépassées</strong>
      <ul>
        {quote.warnings.map((w) => (
          <li key={w.code}>{COWORKING_MESSAGES[w.code] ?? w.message}</li>
        ))}
      </ul>
      <label className="row center" style={{ gap: 8 }}>
        <input type="checkbox" className="chk" checked={override} onChange={(e) => onOverride(e.target.checked)} />
        <span>Passer outre (tracé au journal d'audit)</span>
      </label>
    </div>
  );
}

/** The start slot to propose at a time: the latest start at or before it that has not ended, else the next one. */
function defaultSlot(slots: SlotsResponse["slots"], time: string): string {
  const now = Date.now();
  const open = slots.filter((s) => new Date(s.endsAt).getTime() > now);
  const covering = open.filter((s) => s.startTime <= time && time < s.endTime);
  return (covering.at(-1) ?? open.find((s) => s.startTime >= time) ?? open[0])?.startTime ?? "";
}

/**
 * Booking form of the desk for one resource: client, format, start, length of a free format, promotion code. The
 * quote follows every change; limits of the portal are shown and must be overridden explicitly.
 */
export function QuickBooking({
  resource,
  date,
  time,
  member: fixedMember,
  onCreated,
  autoFocus,
}: {
  resource: { id: string; code: string; typeId: string };
  date: string;
  time: string;
  member?: MemberRow | undefined;
  onCreated: (booking: Booking & { quote: Quote }) => void;
  autoFocus?: boolean;
}) {
  const [member, setMember] = useState<MemberRow | null>(fixedMember ?? null);
  const formats = useFormats();
  const choices = (formats.data ?? []).filter((f) => f.typeId === resource.typeId && f.prices.length > 0);
  const [formatId, setFormatId] = useState("");
  const format = choices.find((f) => f.id === formatId) ?? choices[0];
  const [duration, setDuration] = useState<number | null>(null);
  const minutes = format?.nature === "free" ? (duration ?? format.minMinutes ?? undefined) : undefined;
  const [startTime, setStartTime] = useState("");
  const [promo, setPromo] = useState("");
  const [debouncedPromo, setDebouncedPromo] = useState("");
  const [notes, setNotes] = useState("");
  const [override, setOverride] = useState(false);
  const client = useQueryClient();
  const toast = useToast();
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedPromo(promo.trim().toUpperCase()), 400);
    return () => window.clearTimeout(t);
  }, [promo]);

  const slots = useQuery({
    queryKey: ["cw-slots", format?.id, date, minutes],
    queryFn: () => api.get<SlotsResponse>(`/coworking/formats/${format!.id}/slots`, { date, durationMinutes: minutes }),
    enabled: !!format,
  });
  const usableSlots = (slots.data?.slots ?? []).filter((s) => new Date(s.endsAt).getTime() > Date.now());
  const start = usableSlots.some((s) => s.startTime === startTime) ? startTime : defaultSlot(slots.data?.slots ?? [], time);

  const input: BookingInput | null =
    member && format && start
      ? {
          memberId: member.id,
          resourceId: resource.id,
          formatId: format.id,
          date,
          startTime: start,
          ...(minutes !== undefined ? { durationMinutes: minutes } : {}),
          ...(debouncedPromo ? { promoCode: debouncedPromo } : {}),
        }
      : null;
  const quote = useQuery({
    queryKey: ["cw-quote", input],
    queryFn: () => api.post<Quote>("/coworking/bookings/quote", input),
    enabled: !!input,
    staleTime: 0,
  });
  useEffect(() => setOverride(false), [quote.data]);

  const create = useMutation({
    mutationFn: () =>
      api.post<Booking & { quote: Quote }>("/coworking/bookings", { ...input, ...(notes.trim() ? { notes: notes.trim() } : {}), override }),
    onSuccess: async (created) => {
      await client.invalidateQueries();
      toast(`Réservation ${created.resourceCode} enregistrée.`);
      onCreated(created);
    },
  });

  const durations: number[] = [];
  if (format?.nature === "free" && format.minMinutes && format.maxMinutes && format.startStepMinutes) {
    for (let m = format.minMinutes; m <= format.maxMinutes; m += format.startStepMinutes) durations.push(m);
  }
  const needsOverride = !!quote.data?.warnings.length && !override;

  return (
    <div className="stack">
      {member ? (
        <div className="row between center">
          <div>
            <div className="lab">Client</div>
            <strong>{memberName(member)}</strong>
            {member.phone ? <span className="cap"> · {member.phone}</span> : null}
          </div>
          {fixedMember ? null : (
            <button type="button" className="btn btn-g" onClick={() => setMember(null)}>
              Changer
            </button>
          )}
        </div>
      ) : (
        <MemberPicker onPick={setMember} autoFocus={autoFocus} />
      )}
      {formats.isPending ? (
        <Loading />
      ) : choices.length === 0 ? (
        <div className="ban ban-amber">
          <span>Aucun format tarifé pour ce type de ressource : configurez-le dans les paramètres coworking.</span>
        </div>
      ) : (
        <div className="grid2">
          <Field label="Format">
            <select className="input" value={format?.id ?? ""} onChange={(e) => (setFormatId(e.target.value), setStartTime(""), setDuration(null))}>
              {choices.map((f) => (
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
          <Field label="Début" error={slots.data && usableSlots.length === 0 ? (slots.data.open ? "Plus aucun créneau ce jour" : "Fermé ce jour") : null}>
            <select className="input" value={start} onChange={(e) => setStartTime(e.target.value)} disabled={!usableSlots.length}>
              {usableSlots.map((s) => (
                <option key={s.startTime} value={s.startTime}>
                  {s.startTime}-{s.endTime}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Code promotionnel (facultatif)">
            <input className="input" value={promo} maxLength={30} onChange={(e) => setPromo(e.target.value)} />
          </Field>
        </div>
      )}
      <Field label="Note (facultatif)">
        <input className="input" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <ErrorBanner error={slots.error ?? quote.error} />
      {quote.data ? (
        <>
          <QuoteView quote={quote.data} />
          <LimitWarnings quote={quote.data} override={override} onOverride={setOverride} />
        </>
      ) : input && quote.isFetching ? (
        <span className="cap">Calcul du prix…</span>
      ) : null}
      <ErrorBanner error={create.error} />
      <button
        type="button"
        className="btn btn-p btn-l"
        style={{ alignSelf: "flex-start" }}
        disabled={!input || !quote.data || needsOverride || create.isPending}
        onClick={() => create.mutate()}
      >
        Réserver {resource.code}
        {quote.data ? ` · ${tnd(quote.data.charge)} TND` : ""}
      </button>
    </div>
  );
}

/** Key facts of a booking, shared by the drawer and the booking page. */
export function BookingFacts({ booking, paid, due }: { booking: Booking; paid?: number | undefined; due?: number | undefined }) {
  const rows: [string, ReactNode][] = [
    ["Ressource", `${CATEGORY[booking.category]} ${booking.resourceCode} · ${booking.typeName}`],
    [
      "Créneau",
      booking.localDate === localParts(booking.endsAt).date
        ? `${frDate(booking.localDate)} ${booking.startTime}-${booking.endTime}`
        : `${frDateTime(booking.startsAt)} au ${frDateTime(booking.endsAt)}`,
    ],
  ];
  if (booking.kind === "booking") {
    rows.push([
      "Client",
      booking.memberId ? (
        <>
          <Link to={`/coworking/membres/${booking.memberId}`}>{booking.memberName}</Link>
          {booking.memberPhone ? <span className="cap"> · {booking.memberPhone}</span> : null}
        </>
      ) : (
        ""
      ),
    ]);
    rows.push(["Format", `${booking.formatLabel ?? ""}${booking.profile ? ` · tarif ${PROFILE[booking.profile].toLowerCase()}` : ""}`]);
    rows.push(["Montant", `${tnd(booking.charge)} TND${booking.listPrice !== booking.charge ? ` (tarif ${tnd(booking.listPrice)} TND)` : ""}`]);
    if (paid !== undefined && due !== undefined) rows.push(["Réglé", `${tnd(paid)} TND, reste ${tnd(due)} TND`]);
    if (booking.lateCancelFee > 0) rows.push(["Frais d'annulation", `${tnd(booking.lateCancelFee)} TND`]);
    if (booking.checkedInAt) rows.push(["Arrivée", frDateTime(booking.checkedInAt)]);
  }
  if (booking.notes) rows.push([booking.kind === "block" ? "Motif" : "Note", booking.notes]);
  return (
    <div className="xs">
      <table className="tbl">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <td className="lab" style={{ width: 140 }}>
                {label}
              </td>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Moves a booking to another free resource of the same type at the same time. For a request ("proposer une autre
 * ressource") the request is then approved in the same step.
 */
export function ReassignModal({
  booking,
  approve,
  onClose,
}: {
  booking: Pick<Booking, "id" | "memberName" | "typeName" | "resourceCode" | "localDate" | "startTime" | "endTime">;
  approve: boolean;
  onClose: () => void;
}) {
  const alternatives = useQuery({
    queryKey: ["cw-alternatives", booking.id],
    queryFn: () => api.get<{ items: { id: string; code: string; name: string | null; floorName: string }[] }>(`/coworking/bookings/${booking.id}/alternatives`),
    staleTime: 0,
  });
  const [target, setTarget] = useState("");
  const client = useQueryClient();
  const toast = useToast();
  const items = alternatives.data?.items ?? [];
  const chosen = target || items[0]?.id || "";
  const save = useMutation({
    mutationFn: async () => {
      await api.post(`/coworking/bookings/${booking.id}/reassign`, { resourceId: chosen });
      if (approve) await api.post(`/coworking/bookings/${booking.id}/approve`);
    },
    onSuccess: async () => {
      await client.invalidateQueries();
      const code = items.find((i) => i.id === chosen)?.code ?? "";
      toast(approve ? `Demande acceptée sur ${code}.` : `Réservation déplacée sur ${code}.`);
      onClose();
    },
  });
  return (
    <Modal
      title={approve ? "Proposer une autre ressource" : "Changer de ressource"}
      onClose={onClose}
      footer={
        <>
          <span className="cap">Le prix de la réservation ne change pas.</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Retour
            </button>
            <button type="button" className="btn btn-p" disabled={!chosen || save.isPending} onClick={() => save.mutate()}>
              {approve ? "Déplacer et accepter" : "Déplacer"}
            </button>
          </div>
        </>
      }
    >
      <div>
        {booking.memberName ? `${booking.memberName} · ` : ""}
        {booking.typeName} {booking.resourceCode}, {frDate(booking.localDate)} {booking.startTime}-{booking.endTime}
      </div>
      {alternatives.isPending ? (
        <Loading />
      ) : items.length === 0 ? (
        <div className="ban ban-amber">
          <span>Aucune autre ressource de ce type n'est libre sur ce créneau.</span>
        </div>
      ) : (
        <Field label="Nouvelle ressource">
          <select className="input" autoFocus value={chosen} onChange={(e) => setTarget(e.target.value)}>
            {items.map((r) => (
              <option key={r.id} value={r.id}>
                {r.code}
                {r.name ? ` · ${r.name}` : ""} ({r.floorName})
              </option>
            ))}
          </select>
        </Field>
      )}
      <ErrorBanner error={alternatives.error ?? save.error} />
    </Modal>
  );
}

/**
 * Every desk action on a booking for its current status: approve or refuse a request, move it, record the arrival,
 * release the resource, cancel with the fee shown, take a payment.
 */
export function BookingActions({ booking, due, onCollect }: { booking: Booking; due: number; onCollect: (memberId: string) => void }) {
  const { can } = useSession();
  const settings = useSettings();
  const client = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<"refuse" | "cancel" | "reassign" | "propose" | null>(null);
  const act = useMutation({
    mutationFn: (action: "approve" | "check-in" | "release") => api.post<Booking>(`/coworking/bookings/${booking.id}/${action}`),
    onSuccess: async (_b, action) => {
      await client.invalidateQueries();
      toast(action === "approve" ? "Demande acceptée." : action === "check-in" ? "Arrivée enregistrée." : "Ressource libérée.");
    },
    onError: (error) => toast(errorMessage(error), "error"),
  });
  if (!can("coworking:write") || booking.kind !== "booking") return null;
  const now = Date.now();
  const started = new Date(booking.startsAt).getTime() <= now;
  const ended = new Date(booking.endsAt).getTime() <= now;
  const status = booking.status;
  const fee = settings.data ? cancellationFee(booking, settings.data) : null;
  return (
    <>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {status === "requested" ? (
          <>
            <button type="button" className="btn btn-p" disabled={act.isPending} onClick={() => act.mutate("approve")}>
              Accepter
            </button>
            <button type="button" className="btn" onClick={() => setDialog("propose")}>
              Proposer une autre ressource
            </button>
            <button type="button" className="btn" onClick={() => setDialog("refuse")}>
              Refuser
            </button>
          </>
        ) : null}
        {status === "confirmed" && !ended ? (
          <button type="button" className="btn btn-p" disabled={act.isPending} onClick={() => act.mutate("check-in")}>
            Enregistrer l'arrivée
          </button>
        ) : null}
        {(status === "confirmed" || status === "checked_in") && started && !ended ? (
          <button type="button" className="btn" disabled={act.isPending} onClick={() => act.mutate("release")}>
            Libérer maintenant
          </button>
        ) : null}
        {due > 0 && booking.memberId && can("payments:write") ? (
          <button type="button" className="btn" onClick={() => onCollect(booking.memberId!)}>
            Encaisser {tnd(due)} TND
          </button>
        ) : null}
        {status === "confirmed" && !ended ? (
          <button type="button" className="btn" onClick={() => setDialog("reassign")}>
            Changer de ressource
          </button>
        ) : null}
        {status === "requested" || status === "confirmed" ? (
          <button type="button" className="btn btn-d" onClick={() => setDialog("cancel")}>
            Annuler la réservation
          </button>
        ) : null}
      </div>
      {dialog === "refuse" ? (
        <ReasonDialog
          title="Refuser la demande"
          explanation="Le client est prévenu par e-mail avec le motif. Les droits réservés sur ses abonnements et carnets sont rendus."
          confirmLabel="Refuser"
          danger
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => {
            await api.post(`/coworking/bookings/${booking.id}/refuse`, { reason });
            await client.invalidateQueries();
            toast("Demande refusée.");
          }}
        />
      ) : null}
      {dialog === "cancel" ? (
        <ReasonDialog
          title="Annuler la réservation"
          danger
          explanation={
            fee === null ? (
              "Calcul des frais…"
            ) : fee > 0 ? (
              <span>
                Annulation tardive : les droits utilisés restent consommés, l'échéance non payée est annulée et des frais de{" "}
                <strong>{tnd(fee)} TND</strong> sont facturés au client.
              </span>
            ) : (
              "Annulation sans frais : les droits utilisés sont rendus et l'échéance non payée est annulée."
            )
          }
          confirmLabel={fee ? `Annuler avec ${tnd(fee)} TND de frais` : "Annuler la réservation"}
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => {
            const r = await api.post<{ fee: number }>(`/coworking/bookings/${booking.id}/cancel`, { reason });
            await client.invalidateQueries();
            toast(r.fee > 0 ? `Réservation annulée. Frais d'annulation : ${tnd(r.fee)} TND.` : "Réservation annulée sans frais.");
          }}
        />
      ) : null}
      {dialog === "reassign" || dialog === "propose" ? <ReassignModal booking={booking} approve={dialog === "propose"} onClose={() => setDialog(null)} /> : null}
    </>
  );
}

/** Drawer content for one booking: status, facts and actions, with links to the booking and the client. */
export function BookingPanel({ bookingId, onCollect }: { bookingId: string; onCollect: (memberId: string) => void }) {
  const detail = useQuery({
    queryKey: ["cw-booking", bookingId],
    queryFn: () => api.get<BookingDetail>(`/coworking/bookings/${bookingId}`),
  });
  if (detail.isPending) return <Loading />;
  if (detail.error) return <ErrorBanner error={detail.error} retry={() => detail.refetch()} />;
  const b = detail.data;
  if (b.kind === "block") return <BlockPanel block={b} />;
  return (
    <div className="stack">
      <div className="row between center">
        <BookingStatusBadge status={b.status} />
        <Link to={`/coworking/reservations/${b.id}`}>Ouvrir la réservation</Link>
      </div>
      <BookingFacts booking={b} paid={b.paid} due={b.due} />
      <BookingActions booking={b} due={b.due} onCollect={onCollect} />
    </div>
  );
}

/** A block: its reason and period, and the action that removes it while it still occupies the resource. */
export function BlockPanel({ block }: { block: Booking }) {
  const { can } = useSession();
  const client = useQueryClient();
  const toast = useToast();
  const remove = useMutation({
    mutationFn: () => api.del(`/coworking/blocks/${block.id}`),
    onSuccess: async () => {
      await client.invalidateQueries();
      toast("Blocage retiré.");
    },
  });
  return (
    <div className="stack">
      <div>
        <Badge tone="gray">{block.status === "confirmed" ? "Bloquée" : "Blocage retiré"}</Badge>
      </div>
      <BookingFacts booking={block} />
      <ErrorBanner error={remove.error} />
      {can("coworking:write") && block.status === "confirmed" ? (
        <button type="button" className="btn" style={{ alignSelf: "flex-start" }} disabled={remove.isPending} onClick={() => remove.mutate()}>
          Retirer le blocage
        </button>
      ) : null}
    </div>
  );
}

/** Blocks a resource for a period (maintenance, private event): staff only, with a mandatory reason. */
export function BlockModal({
  resources,
  resourceId,
  date,
  time,
  onClose,
}: {
  resources: { id: string; code: string; typeName: string }[];
  resourceId?: string | undefined;
  date: string;
  time: string;
  onClose: () => void;
}) {
  const [target, setTarget] = useState(resourceId ?? resources[0]?.id ?? "");
  const [startDate, setStartDate] = useState(date);
  const [startTime, setStartTime] = useState(time);
  const [endDate, setEndDate] = useState(date);
  const [endTime, setEndTime] = useState(fromMinutes(Math.min(toMinutes(time) + 60, 23 * 60 + 45)));
  const [reason, setReason] = useState("");
  const client = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: () => api.post("/coworking/blocks", { resourceId: target, startDate, startTime, endDate, endTime, reason: reason.trim() }),
    onSuccess: async () => {
      await client.invalidateQueries();
      toast("Ressource bloquée.");
      onClose();
    },
  });
  const valid = target && reason.trim() && `${endDate} ${endTime}` > `${startDate} ${startTime}`;
  return (
    <Modal
      title="Bloquer une ressource"
      onClose={onClose}
      footer={
        <>
          <span className="cap">Les réservations en cours sur la période empêchent le blocage.</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
              Bloquer
            </button>
          </div>
        </>
      }
    >
      <Field label="Ressource">
        <select className="input" value={target} onChange={(e) => setTarget(e.target.value)} disabled={!!resourceId}>
          {resources.map((r) => (
            <option key={r.id} value={r.id}>
              {r.code} · {r.typeName}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid2">
        <Field label="Début, date">
          <input className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </Field>
        <Field label="Début, heure">
          <input className="input" type="time" step={900} value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        </Field>
        <Field label="Fin, date">
          <input className="input" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </Field>
        <Field label="Fin, heure">
          <input className="input" type="time" step={900} value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </Field>
      </div>
      <Field label="Motif (obligatoire)">
        <textarea className="input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

/** Whether staff can book the resource directly (assigned desks and offices go through subscriptions). */
export const isDeskBookable = (r: { category: CwCategory; status: string }) => r.status === "active" && isBookableCategory(r.category);
