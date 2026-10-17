import { FloorPlanView } from "@gcf/floorplan";
import { CW_CATEGORY_LABELS, PLAN_STATES } from "@gcf/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api/client";
import type { Booking, BookingInput, Catalogue, CatalogueType, FloorStateResponse, FormatOffer, Quote, Slot, Slots } from "../api/types";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Money, Notice, PageHeader, Spinner } from "../components/ui";
import { useI18n } from "../i18n/i18n";
import { useFormat } from "../lib/format";

/** Lengths a free format can be booked for: multiples of its step between its minimum and maximum. */
function durations(format: FormatOffer): number[] {
  const step = format.startStepMinutes ?? 0;
  if (format.nature !== "free" || !step || format.minMinutes === null || format.maxMinutes === null) return [];
  const values: number[] = [];
  for (let m = format.minMinutes; m <= format.maxMinutes; m += step) values.push(m);
  return values;
}

/** Natural size of the floor plan image, which the plan needs to keep the placed resources on their spots. */
function useImageSize(url: string | null): { width: number; height: number } | null {
  const [size, setSize] = useState<{ url: string; width: number; height: number } | null>(null);
  useEffect(() => {
    if (!url) return;
    const image = new Image();
    image.onload = () => setSize({ url, width: image.naturalWidth, height: image.naturalHeight });
    image.src = url;
    return () => {
      image.onload = null;
    };
  }, [url]);
  return size && size.url === url ? { width: size.width, height: size.height } : null;
}

function PriceLine({ format, offpeakFrom }: { format: FormatOffer; offpeakFrom: string | null }) {
  const { t } = useI18n();
  const f = useFormat();
  const base = `${f.money(format.price.amount)}${format.price.perHour ? ` ${t.book.perHour}` : ""}`;
  return (
    <span>
      {base}
      {format.price.offpeakAmount !== null && offpeakFrom ? (
        <span className="cap"> ({t.book.offpeak(f.money(format.price.offpeakAmount), offpeakFrom)})</span>
      ) : null}
    </span>
  );
}

function TypeCard({ type, offpeakFrom, selected, onSelect }: { type: CatalogueType; offpeakFrom: string | null; selected: boolean; onSelect: () => void }) {
  const { t, language } = useI18n();
  return (
    <div className={`card portal-choice${selected ? " on" : ""}`}>
      {type.photoUrl ? <img className="portal-photo" src={type.photoUrl} alt="" /> : null}
      <div className="card-b stack" style={{ gap: 8 }}>
        <div className="row between center" style={{ gap: 8 }}>
          <h3 className="h3">{type.name}</h3>
          <Badge tone="neutral">{CW_CATEGORY_LABELS[language][type.category]}</Badge>
        </div>
        {type.description ? <p className="cap">{type.description}</p> : null}
        <span className="cap">{t.book.capacity(type.capacity.min, type.capacity.max)}</span>
        <ul className="stack" style={{ gap: 2 }}>
          {type.formats.map((format) => (
            <li key={format.id}>
              {t.common.pair(format.label, "")}
              <PriceLine format={format} offpeakFrom={offpeakFrom} />
            </li>
          ))}
        </ul>
        {type.requiresApproval ? <span className="cap">{t.book.requiresApproval}</span> : null}
        <button type="button" className={selected ? "btn btn-p" : "btn"} aria-pressed={selected} onClick={onSelect}>
          {selected ? t.book.chosen : t.book.choose}
          <span className="visually-hidden"> {type.name}</span>
        </button>
      </div>
    </div>
  );
}

function SlotPicker({ slots, selected, onSelect }: { slots: Slots; selected: Slot | null; onSelect: (slot: Slot) => void }) {
  const { t } = useI18n();
  if (!slots.open) {
    return (
      <Notice tone="amber">
        {t.book.closedDay} {slots.closures.length ? t.book.closures(slots.closures.join(", ")) : null}
      </Notice>
    );
  }
  if (!slots.slots.length) return <Notice tone="amber">{t.book.noSlots}</Notice>;
  return (
    <div className="stack" style={{ gap: 8 }}>
      {slots.closures.length ? <Notice tone="amber">{t.book.closures(slots.closures.join(", "))}</Notice> : null}
      <div className="portal-slots" role="group" aria-label={t.book.slots}>
        {slots.slots.map((slot) => {
          const on = selected?.startTime === slot.startTime && selected.endTime === slot.endTime;
          return (
            <button
              key={slot.startTime}
              type="button"
              className={on ? "btn btn-p" : "btn"}
              aria-pressed={on}
              disabled={slot.free === 0}
              onClick={() => onSelect(slot)}
            >
              <span className="num">
                {slot.startTime} - {slot.endTime}
              </span>
              <span className="cap" style={on ? { color: "inherit" } : undefined}>
                {t.book.free(slot.free)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PlanLegend() {
  const { t } = useI18n();
  return (
    <div className="fp-legend">
      {PLAN_STATES.map((s) => (
        <span key={s}>
          <i className={s} aria-hidden="true" />
          {t.planState[s]}
        </span>
      ))}
    </div>
  );
}

function ResourcePicker({
  state,
  typeId,
  selected,
  onSelect,
}: {
  state: FloorStateResponse;
  typeId: string;
  selected: string | null;
  onSelect: (resourceId: string) => void;
}) {
  const { t } = useI18n();
  const planImage = state.floor.planMediaId ? `/media/${state.floor.planMediaId}` : null;
  const size = useImageSize(planImage);
  const byId = new Map(state.resources.map((r) => [r.resourceId, r]));
  const free = state.resources.filter((r) => r.typeId === typeId && r.state === "free");
  const layout = state.floor.layout;
  const planReady = layout.items.length > 0 && (!planImage || size !== null);
  return (
    <div className="stack">
      <p className="cap">{t.book.chooseResource}</p>
      {layout.items.length ? (
        planReady ? (
          <>
            <PlanLegend />
            <div className="portal-plan">
              <FloorPlanView
                layout={layout}
                image={planImage && size ? { url: planImage, ...size } : null}
                title={t.book.planTitle(state.floor.name)}
                selectedId={selected}
                onSelect={onSelect}
                appearance={(id) => {
                  const r = byId.get(id);
                  if (!r) return undefined;
                  return {
                    label: r.code,
                    title: t.book.resourceTitle(r.code, t.planState[r.state]),
                    state: r.state,
                    disabled: r.typeId !== typeId || r.state !== "free",
                  };
                }}
              />
            </div>
          </>
        ) : (
          <Loading />
        )
      ) : (
        <span className="cap">{t.book.planUnavailable}</span>
      )}
      <h3 className="h3">{t.book.freeResources}</h3>
      {free.length ? (
        <div className="portal-slots" role="group" aria-label={t.book.freeResources}>
          {free.map((r) => (
            <button
              key={r.resourceId}
              type="button"
              className={selected === r.resourceId ? "btn btn-p" : "btn"}
              aria-pressed={selected === r.resourceId}
              onClick={() => onSelect(r.resourceId)}
            >
              {r.code}
              {r.name ? (
                <span className="cap" style={selected === r.resourceId ? { color: "inherit" } : undefined}>
                  {r.name}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : (
        <Notice tone="amber">{t.book.noFreeResource}</Notice>
      )}
    </div>
  );
}

function Summary({ input, catalogue, onPromo }: { input: BookingInput; catalogue: Catalogue; onPromo: (code: string | null) => void }) {
  const { t, language } = useI18n();
  const f = useFormat();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [promoText, setPromoText] = useState(input.promoCode ?? "");
  const [notes, setNotes] = useState("");
  const quote = useQuery({ queryKey: ["quote", input], queryFn: () => api.post<Quote>("/bookings/quote", input) });
  const create = useMutation({
    mutationFn: () => api.post<Booking>("/bookings", notes.trim() ? { ...input, notes: notes.trim() } : input),
    onSuccess: async (booking) => {
      await client.invalidateQueries({ queryKey: ["bookings"] });
      await client.invalidateQueries({ queryKey: ["account"] });
      await client.invalidateQueries({ queryKey: ["subscription"] });
      await client.invalidateQueries({ queryKey: ["packs"] });
      navigate(`/reservations/${booking.id}`, { state: { created: booking.status === "requested" ? "requested" : "confirmed" } });
    },
  });
  const q = quote.data;
  return (
    <Card title={t.book.stepSummary}>
      <div className="card-b stack">
        <ErrorBanner error={quote.error} />
        {quote.isPending ? <Loading /> : null}
        {q ? (
          <>
            <table className="tbl">
              <tbody>
                <tr>
                  <td>{t.book.space}</td>
                  <td className="num">
                    {CW_CATEGORY_LABELS[language][q.resource.category]} {q.resource.code}
                  </td>
                </tr>
                <tr>
                  <td>{t.book.when}</td>
                  <td className="num">
                    {f.date(q.date, true)}, {q.startTime} - {q.endTime}
                  </td>
                </tr>
                <tr>
                  <td>
                    {t.book.listPrice}{" "}
                    <span className="cap">
                      ({t.profile[q.profile]}
                      {q.offpeak ? `, ${t.book.offpeakApplied}` : ""})
                    </span>
                  </td>
                  <td className="num">
                    <Money value={q.listPrice} />
                  </td>
                </tr>
                {q.coverage.coveredMinutes > 0 ? (
                  <tr>
                    <td>{t.book.coverage(f.minutes(q.coverage.coveredMinutes))}</td>
                    <td className="num">- {f.money(q.coverage.discount)}</td>
                  </tr>
                ) : null}
                {q.promotion ? (
                  <tr>
                    <td>{t.book.promoDiscount(q.promotion.code)}</td>
                    <td className="num">- {f.money(q.promotion.discount)}</td>
                  </tr>
                ) : null}
              </tbody>
              <tfoot>
                <tr>
                  <td>
                    {t.book.total}
                    {q.charge > 0 ? <span className="cap"> ({t.common.payAtDesk})</span> : null}
                  </td>
                  <td className="num">
                    <Money value={q.charge} strong />
                  </td>
                </tr>
              </tfoot>
            </table>
            <Notice tone="blue">{q.status === "requested" ? t.book.statusRequested : t.book.statusConfirmed}</Notice>
          </>
        ) : null}
        <form
          className="row"
          style={{ gap: 8, alignItems: "flex-end" }}
          onSubmit={(e) => {
            e.preventDefault();
            onPromo(promoText.trim() || null);
          }}
        >
          <div style={{ flex: "1 1 200px" }}>
            <Field label={`${t.book.promoCode} (${t.common.optional})`}>
              <input className="input" value={promoText} maxLength={30} autoCapitalize="characters" onChange={(e) => setPromoText(e.target.value)} />
            </Field>
          </div>
          <button type="submit" className="btn" disabled={!promoText.trim()}>
            {t.book.apply}
          </button>
          {input.promoCode ? (
            <button
              type="button"
              className="btn btn-g"
              onClick={() => {
                setPromoText("");
                onPromo(null);
              }}
            >
              {t.book.removePromo}
            </button>
          ) : null}
        </form>
        <Field label={`${t.book.notes} (${t.common.optional})`}>
          <textarea className="input" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <p className="cap">{t.book.cancelPolicy(catalogue.rules.freeCancelHours, f.percent(catalogue.rules.lateCancelFeeBp))}</p>
        <ErrorBanner error={create.error} />
      </div>
      <div className="card-f">
        <span />
        <button type="button" className="btn btn-p btn-l" disabled={!q || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? <Spinner /> : q?.status === "requested" ? t.book.request : t.book.confirm}
        </button>
      </div>
    </Card>
  );
}

export function BookPage() {
  const { t } = useI18n();
  const f = useFormat();
  const catalogue = useQuery({ queryKey: ["catalogue"], queryFn: () => api.get<Catalogue>("/catalogue") });
  const [typeId, setTypeId] = useState<string | null>(null);
  const [formatId, setFormatId] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [floorId, setFloorId] = useState<string | null>(null);
  const [resourceId, setResourceId] = useState<string | null>(null);
  const [promoCode, setPromoCode] = useState<string | null>(null);

  const data = catalogue.data;
  const type = data?.types.find((x) => x.id === typeId) ?? null;
  const format = type?.formats.find((x) => x.id === formatId) ?? null;
  const day = date ?? data?.date ?? null;
  const floor = type?.floors.find((x) => x.id === floorId) ?? type?.floors[0] ?? null;
  const lengths = format ? durations(format) : [];
  const length = format?.nature === "free" ? (duration ?? lengths[0] ?? null) : null;

  const slots = useQuery({
    queryKey: ["slots", format?.id, day, length],
    queryFn: () => api.get<Slots>(`/formats/${format!.id}/slots`, { date: day, durationMinutes: length }),
    enabled: !!format && !!day,
  });
  const floorState = useQuery({
    queryKey: ["floor-state", floor?.id, day, slot?.startTime, slot?.endTime],
    queryFn: () => api.get<FloorStateResponse>(`/floors/${floor!.id}/state`, { date: day, startTime: slot!.startTime, endTime: slot!.endTime }),
    enabled: !!floor && !!day && !!slot,
  });

  /** A change earlier in the flow invalidates what was picked after it. */
  const resetSelection = (includingSlot: boolean) => {
    if (includingSlot) setSlot(null);
    setResourceId(null);
    setPromoCode(null);
  };

  if (catalogue.isPending) return <Loading />;
  if (!data) return <ErrorBanner error={catalogue.error} retry={() => catalogue.refetch()} />;

  const input: BookingInput | null =
    format && day && slot && resourceId
      ? {
          resourceId,
          formatId: format.id,
          date: day,
          startTime: slot.startTime,
          ...(length !== null ? { durationMinutes: length } : {}),
          ...(promoCode ? { promoCode } : {}),
        }
      : null;

  return (
    <>
      <PageHeader title={t.book.title} />
      <Card title={t.book.stepSpace}>
        <div className="card-b">
          {data.types.length ? (
            <div className="portal-cards">
              {data.types.map((x) => (
                <TypeCard
                  key={x.id}
                  type={x}
                  offpeakFrom={data.offpeakFrom}
                  selected={x.id === typeId}
                  onSelect={() => {
                    setTypeId(x.id);
                    setFormatId(x.formats[0]?.id ?? null);
                    setFloorId(x.floors[0]?.id ?? null);
                    setDuration(null);
                    resetSelection(true);
                  }}
                />
              ))}
            </div>
          ) : (
            <Empty title={t.book.noTypes} />
          )}
        </div>
      </Card>

      {type && format ? (
        <Card title={t.book.stepFormat}>
          <div className="card-b stack">
            <div className="grid3 portal-grid">
              <Field label={t.book.format}>
                <select
                  className="input"
                  value={format.id}
                  onChange={(e) => {
                    setFormatId(e.target.value);
                    setDuration(null);
                    resetSelection(true);
                  }}
                >
                  {type.formats.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t.book.date} hint={t.book.horizon(f.date(data.rules.horizonEnd))}>
                <input
                  className="input"
                  type="date"
                  required
                  min={data.date}
                  max={data.rules.horizonEnd}
                  value={day ?? ""}
                  onChange={(e) => {
                    if (!e.target.value) return;
                    setDate(e.target.value);
                    resetSelection(true);
                  }}
                />
              </Field>
              {lengths.length ? (
                <Field label={t.book.duration}>
                  <select
                    className="input"
                    value={length ?? ""}
                    onChange={(e) => {
                      setDuration(Number(e.target.value));
                      resetSelection(true);
                    }}
                  >
                    {lengths.map((m) => (
                      <option key={m} value={m}>
                        {f.minutes(m)}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
            </div>
            <span>
              <PriceLine format={format} offpeakFrom={data.offpeakFrom} />
            </span>
          </div>
        </Card>
      ) : null}

      {type && format ? (
        <Card title={t.book.stepSlot}>
          <div className="card-b stack">
            <ErrorBanner error={slots.error} />
            {slots.isPending ? (
              <Loading />
            ) : slots.data ? (
              <SlotPicker
                slots={slots.data}
                selected={slot}
                onSelect={(next) => {
                  setSlot(next);
                  resetSelection(false);
                }}
              />
            ) : null}
          </div>
        </Card>
      ) : null}

      {type && slot && floor ? (
        <Card
          title={t.book.stepPlace}
          actions={
            type.floors.length > 1 ? (
              <label className="row center" style={{ gap: 8 }}>
                <span className="lab">{t.book.floor}</span>
                <select
                  className="input"
                  style={{ width: "auto" }}
                  value={floor.id}
                  onChange={(e) => {
                    setFloorId(e.target.value);
                    resetSelection(false);
                  }}
                >
                  {type.floors.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span className="cap">{floor.name}</span>
            )
          }
        >
          <div className="card-b">
            <ErrorBanner error={floorState.error} />
            {floorState.isPending ? (
              <Loading />
            ) : floorState.data ? (
              <ResourcePicker
                state={floorState.data}
                typeId={type.id}
                selected={resourceId}
                onSelect={(id) => {
                  setResourceId(id);
                  setPromoCode(null);
                }}
              />
            ) : null}
          </div>
        </Card>
      ) : null}

      {input ? <Summary key={`${input.resourceId}-${input.startTime}-${input.date}`} input={input} catalogue={data} onPromo={setPromoCode} /> : null}
    </>
  );
}
