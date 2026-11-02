import { FloorPlanView } from "@gcf/floorplan";
import { CW_CATEGORY_LABELS, PLAN_STATES } from "@gcf/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "../api/client";
import { usePortal } from "../auth/session";
import type { Booking, BookingInput, Catalogue, CatalogueType, FloorStateResponse, FormatOffer, Quote, Slot, Slots } from "../api/types";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Money, Notice, PageHeader, Spinner } from "../components/ui";
import { useI18n } from "../i18n/i18n";
import { useFormat } from "../lib/format";
import { LoginForm, SignupForm } from "./auth";

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
                    category: r.category,
                    capacity: r.capacity,
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

function Summary({
  input,
  catalogue,
  onPromo,
  onBooked,
}: {
  input: BookingInput;
  catalogue: Catalogue;
  onPromo: (code: string | null) => void;
  onBooked: () => void;
}) {
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
      onBooked();
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

const SELECTION_KEY = "gcf.portal.booking";

/** What the visitor picked, kept in this tab so signing in, or coming back after the account is validated, resumes it. */
interface Selection {
  typeId: string | null;
  formatId: string | null;
  date: string | null;
  duration: number | null;
  slot: Slot | null;
  floorId: string | null;
  resourceId: string | null;
}

const EMPTY: Selection = { typeId: null, formatId: null, date: null, duration: null, slot: null, floorId: null, resourceId: null };

function readSelection(): Selection {
  try {
    const raw = window.sessionStorage.getItem(SELECTION_KEY);
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<Selection>) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

function writeSelection(selection: Selection | null): void {
  try {
    if (selection) window.sessionStorage.setItem(SELECTION_KEY, JSON.stringify(selection));
    else window.sessionStorage.removeItem(SELECTION_KEY);
  } catch {
    // Storage refused (private window): the choice simply lasts as long as the page.
  }
}

/** Brings the next step into view once it is rendered. */
const reveal = (id: string) => window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);

function Progress({ step }: { step: number }) {
  const { t } = useI18n();
  return (
    <ol className="portal-progress" aria-label={t.book.progressLabel}>
      {t.book.progress.map((label, index) => (
        <li key={label} className={index < step ? "done" : index === step ? "on" : undefined} aria-current={index === step ? "step" : undefined}>
          <span className="portal-progress-n" aria-hidden="true">
            {index + 1}
          </span>
          {label}
        </li>
      ))}
    </ol>
  );
}

/** The price a new account would pay, from the catalogue: the exact quote needs the account (subscriptions, packs). */
function estimate(format: FormatOffer, slot: Slot, offpeakFrom: string | null): number {
  const offpeak = format.price.offpeakAmount !== null && offpeakFrom !== null && slot.startTime >= offpeakFrom;
  const rate = offpeak ? format.price.offpeakAmount! : format.price.amount;
  return format.price.perHour ? Math.round((rate * slot.minutes) / 60) : rate;
}

/** Last step for a visitor not signed in: what was chosen, an indicative price, then sign up or sign in on the spot. */
function GuestConfirm({
  type,
  format,
  date,
  slot,
  resourceCode,
  offpeakFrom,
}: {
  type: CatalogueType;
  format: FormatOffer;
  date: string;
  slot: Slot;
  resourceCode: string;
  offpeakFrom: string | null;
}) {
  const { t } = useI18n();
  const f = useFormat();
  const { info } = usePortal();
  const signupOpen = info?.selfSignup !== "closed";
  const [mode, setMode] = useState<"signup" | "login">(signupOpen ? "signup" : "login");
  const [pending, setPending] = useState(false);
  return (
    <Card title={t.book.stepSummary}>
      <div className="card-b stack">
        <table className="tbl">
          <tbody>
            <tr>
              <td>{t.book.space}</td>
              <td className="num">
                {type.name} {resourceCode}
              </td>
            </tr>
            <tr>
              <td>{t.book.when}</td>
              <td className="num">
                {f.date(date, true)}, {slot.startTime} - {slot.endTime}
              </td>
            </tr>
            <tr>
              <td>
                {t.book.estimate} <span className="cap">({format.label})</span>
              </td>
              <td className="num">
                <Money value={estimate(format, slot, offpeakFrom)} strong />
              </td>
            </tr>
          </tbody>
        </table>
        <p className="cap">{t.book.estimateHint}</p>
        <h3 className="h3">{t.book.guestTitle}</h3>
        <p className="cap">{t.book.guestIntro}</p>
        {pending ? (
          <Notice tone="green">{t.book.pendingKept}</Notice>
        ) : (
          <>
            {signupOpen ? (
              <div className="seg" role="group" aria-label={t.book.guestTitle}>
                <button type="button" className="btn" aria-pressed={mode === "signup"} onClick={() => setMode("signup")}>
                  {t.book.newClient}
                </button>
                <button type="button" className="btn" aria-pressed={mode === "login"} onClick={() => setMode("login")}>
                  {t.book.existingClient}
                </button>
              </div>
            ) : (
              <Notice tone="blue">{t.book.signupClosedHere}</Notice>
            )}
            {mode === "signup" && signupOpen ? (
              <SignupForm onActive={() => reveal("step-confirm")} onPending={() => setPending(true)} />
            ) : (
              <>
                <LoginForm onDone={() => reveal("step-confirm")} />
                <Link to="/mot-de-passe-oublie" className="cap">
                  {t.auth.forgotLink}
                </Link>
              </>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

export function BookPage() {
  const { t } = useI18n();
  const f = useFormat();
  const { member } = usePortal();
  const [params] = useSearchParams();
  const catalogue = useQuery({ queryKey: ["catalogue", member?.id ?? null], queryFn: () => api.get<Catalogue>("/catalogue") });
  const [sel, setSel] = useState<Selection>(readSelection);
  const [promoCode, setPromoCode] = useState<string | null>(null);
  const update = (next: Partial<Selection>) => setSel((current) => ({ ...current, ...next }));
  useEffect(() => writeSelection(sel), [sel]);

  const data = catalogue.data;
  const pickType = (x: CatalogueType) => {
    update({ typeId: x.id, formatId: x.formats[0]?.id ?? null, floorId: x.floors[0]?.id ?? null, duration: null, slot: null, resourceId: null });
    setPromoCode(null);
  };
  // A link from the site names the type (?type=); a centre offering a single type needs no first choice.
  const requested = params.get("type");
  useEffect(() => {
    if (!data) return;
    const wanted = data.types.find((x) => x.id === requested) ?? (data.types.length === 1 ? data.types[0] : undefined);
    if (wanted && sel.typeId !== wanted.id && (requested !== null || sel.typeId === null)) {
      pickType(wanted);
      reveal("step-when");
    }
    // Only a new catalogue or a new link applies the default; later choices stay the visitor's.
  }, [data, requested]);

  const type = data?.types.find((x) => x.id === sel.typeId) ?? null;
  const format = type?.formats.find((x) => x.id === sel.formatId) ?? type?.formats[0] ?? null;
  const day = sel.date ?? data?.date ?? null;
  const floor = type?.floors.find((x) => x.id === sel.floorId) ?? type?.floors[0] ?? null;
  const lengths = format ? durations(format) : [];
  const length = format?.nature === "free" ? (sel.duration ?? lengths[0] ?? null) : null;
  const slot = sel.slot;

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

  if (catalogue.isPending) return <Loading />;
  if (!data) return <ErrorBanner error={catalogue.error} retry={() => catalogue.refetch()} />;

  // A kept choice may no longer hold (slot taken, past): it is shown only while the live data still offers it.
  const slotStillFree = slot !== null && (slots.data?.slots.some((x) => x.startTime === slot.startTime && x.endTime === slot.endTime && x.free > 0) ?? false);
  const resource = floorState.data?.resources.find((r) => r.resourceId === sel.resourceId && r.state === "free" && r.typeId === type?.id) ?? null;
  const step = !type ? 0 : !slotStillFree ? 1 : !resource ? 2 : 3;

  const input: BookingInput | null =
    format && day && slot && slotStillFree && resource
      ? {
          resourceId: resource.resourceId,
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
      <Progress step={step} />
      <Card title={t.book.stepSpace}>
        <div className="card-b">
          {data.types.length ? (
            <div className="portal-cards">
              {data.types.map((x) => (
                <TypeCard
                  key={x.id}
                  type={x}
                  offpeakFrom={data.offpeakFrom}
                  selected={x.id === sel.typeId}
                  onSelect={() => {
                    pickType(x);
                    reveal("step-when");
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
        <section id="step-when" className="portal-step">
          <Card title={t.book.stepWhen}>
            <div className="card-b stack">
              <div className="grid3 portal-grid">
                {type.formats.length > 1 ? (
                  <Field label={t.book.format}>
                    <select
                      className="input"
                      value={format.id}
                      onChange={(e) => {
                        update({ formatId: e.target.value, duration: null, slot: null, resourceId: null });
                        setPromoCode(null);
                      }}
                    >
                      {type.formats.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : null}
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
                      update({ date: e.target.value, slot: null, resourceId: null });
                      setPromoCode(null);
                    }}
                  />
                </Field>
                {lengths.length ? (
                  <Field label={t.book.duration}>
                    <select
                      className="input"
                      value={length ?? ""}
                      onChange={(e) => {
                        update({ duration: Number(e.target.value), slot: null, resourceId: null });
                        setPromoCode(null);
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
                {format.label} : <PriceLine format={format} offpeakFrom={data.offpeakFrom} />
              </span>
              <ErrorBanner error={slots.error} />
              {slots.isPending ? (
                <Loading />
              ) : slots.data ? (
                <SlotPicker
                  slots={slots.data}
                  selected={slotStillFree ? slot : null}
                  onSelect={(next) => {
                    update({ slot: next, resourceId: null });
                    setPromoCode(null);
                    reveal("step-place");
                  }}
                />
              ) : null}
            </div>
          </Card>
        </section>
      ) : null}

      {type && slot && slotStillFree && floor ? (
        <section id="step-place" className="portal-step">
          <Card
            title={t.book.stepPlace}
            actions={
              type.floors.length > 1 ? (
                <label className="row center" style={{ gap: 8 }}>
                  <span className="lab">{t.book.floor}</span>
                  <select className="input" style={{ width: "auto" }} value={floor.id} onChange={(e) => update({ floorId: e.target.value, resourceId: null })}>
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
                  selected={resource?.resourceId ?? null}
                  onSelect={(id) => {
                    update({ resourceId: id });
                    setPromoCode(null);
                    reveal("step-confirm");
                  }}
                />
              ) : null}
            </div>
          </Card>
        </section>
      ) : null}

      {input && format && slot && type && resource ? (
        <section id="step-confirm" className="portal-step">
          {member ? (
            <Summary
              key={`${input.resourceId}-${input.startTime}-${input.date}`}
              input={input}
              catalogue={data}
              onPromo={setPromoCode}
              onBooked={() => writeSelection(null)}
            />
          ) : (
            <GuestConfirm type={type} format={format} date={input.date} slot={slot} resourceCode={resource.code} offpeakFrom={data.offpeakFrom} />
          )}
        </section>
      ) : null}
    </>
  );
}
