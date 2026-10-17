import { CW_CATEGORY_LABELS, isBookableCategory } from "@gcf/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../components/toasts";
import { Card, Empty, ErrorBanner, Field, Loading, Modal, ReasonDialog, Segmented } from "../../components/ui";
import { tnd, tryParseTnd } from "../../lib/format";
import { CW_KEYS, type BookingFormat, type CwSettings, type FormatNature, type Price, type Profile, type ResourceType } from "./api";
import { durationLabel, parseInteger, WEEKDAY_SHORT, weekdaysLabel } from "./helpers";

const NATURE: Record<FormatNature, string> = { fixed: "Durée fixe", named: "Créneau nommé", free: "Durée libre" };
const NATURE_HINT: Record<FormatNature, string> = {
  fixed: "Une durée fixe qui peut commencer à intervalles réguliers depuis l'ouverture, par exemple 1 heure toutes les 30 minutes.",
  named: "Des horaires fixes, par exemple Matinée de 08:00 à 13:00 ou Journée de 08:00 à 18:00.",
  free: "Le client choisit sa durée entre un minimum et un maximum, par pas réguliers. Le prix saisi est un prix par heure.",
};
const STEPS = [15, 30, 60];
const PROFILES: { value: Profile; label: string }[] = [
  { value: "visitor", label: "Visiteur (sans abonnement)" },
  { value: "member", label: "Membre (abonnement en cours)" },
];

function formatDetail(f: BookingFormat): string {
  if (f.nature === "fixed") return `${durationLabel(f.durationMinutes ?? 0)}, départ toutes les ${f.startStepMinutes} min`;
  if (f.nature === "named") return `${f.startTime}-${f.endTime}`;
  return `De ${durationLabel(f.minMinutes ?? 0)} à ${durationLabel(f.maxMinutes ?? 0)}, par pas de ${f.startStepMinutes} min`;
}

function FormatModal({ type, format, onClose }: { type: ResourceType; format: BookingFormat | null; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [label, setLabel] = useState(format?.label ?? "");
  const [nature, setNature] = useState<FormatNature>(format?.nature ?? "fixed");
  const [duration, setDuration] = useState(String(format?.durationMinutes ?? 60));
  const [step, setStep] = useState(format?.startStepMinutes ?? 30);
  const [startTime, setStartTime] = useState(format?.startTime ?? "08:00");
  const [endTime, setEndTime] = useState(format?.endTime ?? "13:00");
  const [min, setMin] = useState(String(format?.minMinutes ?? 60));
  const [max, setMax] = useState(String(format?.maxMinutes ?? 480));
  const [weekdays, setWeekdays] = useState<number[]>(format?.weekdays ?? [1, 2, 3, 4, 5, 6, 7]);
  const [position, setPosition] = useState(String(format?.position ?? 0));
  const durationValue = parseInteger(duration, 15, 1440);
  const minValue = parseInteger(min, 15, 1440);
  const maxValue = parseInteger(max, 15, 1440);
  const positionValue = parseInteger(position, 0, 10_000);
  const errors = {
    duration: nature === "fixed" && durationValue === null ? "Entre 15 et 1440 minutes." : null,
    hours: nature === "named" && !(startTime && endTime && endTime > startTime) ? "L'heure de fin doit suivre l'heure de début." : null,
    min: nature === "free" && minValue === null ? "Entre 15 et 1440 minutes." : null,
    max: nature === "free" && (maxValue === null || (minValue !== null && maxValue < minValue)) ? "Entre le minimum et 1440 minutes." : null,
    weekdays: weekdays.length ? null : "Choisissez au moins un jour.",
    position: positionValue === null ? "Un nombre entier positif." : null,
  };
  const valid = label.trim() !== "" && Object.values(errors).every((e) => e === null);
  const save = useMutation({
    mutationFn: () => {
      const fields =
        nature === "fixed"
          ? { durationMinutes: durationValue, startStepMinutes: step }
          : nature === "named"
            ? { startTime, endTime }
            : { minMinutes: minValue, maxMinutes: maxValue, startStepMinutes: step };
      const body = { label: label.trim(), nature, ...fields, weekdays, position: positionValue };
      return format ? api.patch(`/coworking/formats/${format.id}`, body) : api.post("/coworking/formats", { typeId: type.id, ...body });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: CW_KEYS.formats });
      toast(format ? "Format modifié." : "Format créé. Saisissez ses tarifs pour l'ouvrir à la réservation.");
      onClose();
    },
  });
  return (
    <Modal
      title={format ? `Modifier ${format.label}` : `Nouveau format : ${type.name}`}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="cap">Les réservations restent dans les heures d'ouverture du centre</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <div className="grid2">
        <Field label="Libellé *" hint="Affiché aux clients, par exemple : 1 heure, Demi-journée matin, Journée.">
          <input className="input" value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Ordre d'affichage" error={errors.position}>
          <input className="input num" type="number" min={0} value={position} onChange={(e) => setPosition(e.target.value)} />
        </Field>
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <span className="lab">Nature</span>
        <Segmented
          label="Nature du format"
          value={nature}
          onChange={setNature}
          options={(Object.keys(NATURE) as FormatNature[]).map((value) => ({ value, label: NATURE[value] }))}
        />
        <span className="cap">{NATURE_HINT[nature]}</span>
      </div>
      {nature === "fixed" ? (
        <div className="grid2">
          <Field label="Durée (minutes) *" hint={durationValue ? durationLabel(durationValue) : undefined} error={errors.duration}>
            <input className="input num" type="number" min={15} max={1440} value={duration} onChange={(e) => setDuration(e.target.value)} />
          </Field>
          <Field label="Départ possible toutes les">
            <select className="input" value={step} onChange={(e) => setStep(Number(e.target.value))}>
              {STEPS.map((s) => (
                <option key={s} value={s}>
                  {s} minutes
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : null}
      {nature === "named" ? (
        <div className="grid2">
          <Field label="Début *">
            <input className="input" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </Field>
          <Field label="Fin *" error={errors.hours}>
            <input className="input" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </Field>
        </div>
      ) : null}
      {nature === "free" ? (
        <div className="grid3">
          <Field label="Durée minimale (minutes) *" hint={minValue ? durationLabel(minValue) : undefined} error={errors.min}>
            <input className="input num" type="number" min={15} max={1440} value={min} onChange={(e) => setMin(e.target.value)} />
          </Field>
          <Field label="Durée maximale (minutes) *" hint={maxValue ? durationLabel(maxValue) : undefined} error={errors.max}>
            <input className="input num" type="number" min={15} max={1440} value={max} onChange={(e) => setMax(e.target.value)} />
          </Field>
          <Field label="Pas (départ et durée)">
            <select className="input" value={step} onChange={(e) => setStep(Number(e.target.value))}>
              {STEPS.map((s) => (
                <option key={s} value={s}>
                  {s} minutes
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : null}
      <fieldset className="stack" style={{ border: 0, margin: 0, padding: 0, gap: 6 }}>
        <legend className="lab" style={{ marginBottom: 6 }}>
          Jours proposés
        </legend>
        <div className="row" style={{ gap: 12 }}>
          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
            <label key={d} className="row center" style={{ gap: 6 }}>
              <input
                type="checkbox"
                className="chk"
                checked={weekdays.includes(d)}
                onChange={(e) => setWeekdays(e.target.checked ? [...weekdays, d].sort() : weekdays.filter((x) => x !== d))}
              />
              {WEEKDAY_SHORT[d]}
            </label>
          ))}
        </div>
        {errors.weekdays ? <span className="err-text">{errors.weekdays}</span> : null}
        <span className="cap">Seuls les jours d'ouverture du centre restent réservables.</span>
      </fieldset>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

interface PriceRow {
  amount: string;
  offpeak: string;
}

function PricesModal({ format, offpeakFrom, onClose }: { format: BookingFormat; offpeakFrom: string | null; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const initial = (profile: Profile): PriceRow => {
    const p = format.prices.find((x) => x.profile === profile);
    return { amount: p ? tnd(p.amount) : "", offpeak: p && p.offpeakAmount !== null ? tnd(p.offpeakAmount) : "" };
  };
  const [rows, setRows] = useState<Record<Profile, PriceRow>>({ visitor: initial("visitor"), member: initial("member") });
  const parsed = PROFILES.map(({ value }) => {
    const row = rows[value];
    return {
      profile: value,
      amount: tryParseTnd(row.amount),
      offpeak: tryParseTnd(row.offpeak),
      amountError: row.amount.trim() !== "" && (tryParseTnd(row.amount) ?? -1) < 0,
      offpeakError: row.offpeak.trim() !== "" && ((tryParseTnd(row.offpeak) ?? -1) < 0 || row.amount.trim() === ""),
    };
  });
  const invalid = parsed.some((p) => p.amountError || p.offpeakError);
  const save = useMutation({
    mutationFn: () =>
      api.put(`/coworking/formats/${format.id}/prices`, {
        prices: parsed
          .filter((p): p is typeof p & { amount: number } => p.amount !== null)
          .map<Price>((p) => ({ profile: p.profile, amount: p.amount, offpeakAmount: p.offpeak })),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: CW_KEYS.formats });
      toast("Tarifs enregistrés. Ils s'appliquent aux nouvelles réservations.");
      onClose();
    },
  });
  const perHour = format.nature === "free";
  return (
    <Modal
      title={`Tarifs : ${format.label}`}
      onClose={onClose}
      footer={
        <>
          <span className="cap">Sans aucun tarif, le format n'est pas proposé</span>
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
      <span className="cap">
        {perHour ? "Prix par heure : le montant est calculé au prorata de la durée réservée. " : ""}
        Sans tarif membre, les membres paient le tarif visiteur.{" "}
        {offpeakFrom
          ? `Le tarif heures creuses s'applique aux réservations commençant à ${offpeakFrom} ou plus tard.`
          : "Les heures creuses sont désactivées dans les règles : le tarif heures creuses n'est pas utilisé."}
      </span>
      {PROFILES.map(({ value, label }, i) => (
        <div key={value} className="grid2">
          <Field label={`${label} (TND${perHour ? " / heure" : ""})`} error={parsed[i]!.amountError ? "Montant invalide" : null}>
            <input
              className="input num"
              inputMode="decimal"
              value={rows[value].amount}
              onChange={(e) => setRows({ ...rows, [value]: { ...rows[value], amount: e.target.value } })}
            />
          </Field>
          <Field
            label={`Heures creuses, ${value === "visitor" ? "visiteur" : "membre"} (TND)`}
            hint="Vide : même prix toute la journée."
            error={parsed[i]!.offpeakError ? "Montant invalide ou tarif normal manquant" : null}
          >
            <input
              className="input num"
              inputMode="decimal"
              value={rows[value].offpeak}
              onChange={(e) => setRows({ ...rows, [value]: { ...rows[value], offpeak: e.target.value } })}
            />
          </Field>
        </div>
      ))}
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

function PriceCell({ price, perHour }: { price: Price | undefined; perHour: boolean }) {
  if (!price) return <span className="cap">-</span>;
  return (
    <>
      <span>
        {tnd(price.amount)}
        {perHour ? " / h" : ""}
      </span>
      {price.offpeakAmount !== null ? <div className="cap">Creuses : {tnd(price.offpeakAmount)}</div> : null}
    </>
  );
}

/** Booking formats of each bookable type with their visitor and member price grid. */
export function FormatsTab() {
  const client = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<{ type: ResourceType; format: BookingFormat | null } | null>(null);
  const [pricing, setPricing] = useState<BookingFormat | null>(null);
  const [archiving, setArchiving] = useState<BookingFormat | null>(null);
  const types = useQuery({ queryKey: CW_KEYS.types, queryFn: () => api.get<ResourceType[]>("/coworking/resource-types") });
  const formats = useQuery({ queryKey: CW_KEYS.formats, queryFn: () => api.get<BookingFormat[]>("/coworking/formats") });
  const settings = useQuery({ queryKey: CW_KEYS.settings, queryFn: () => api.get<CwSettings>("/coworking/settings") });
  const bookable = (types.data ?? []).filter((t) => isBookableCategory(t.category));
  if (types.error || formats.error)
    return <ErrorBanner error={types.error ?? formats.error} retry={() => void Promise.all([types.refetch(), formats.refetch()])} />;
  if (types.isPending || formats.isPending) return <Loading />;
  return (
    <>
      {bookable.length === 0 ? (
        <Card>
          <Empty title="Aucun type réservable" text="Créez un type d'espace réservable (poste flexible, salle de réunion...) pour définir ses formats." />
        </Card>
      ) : null}
      {bookable.map((type) => {
        const own = formats.data.filter((f) => f.typeId === type.id);
        return (
          <Card
            key={type.id}
            title={
              <div>
                <h2 className="h2">{type.name}</h2>
                <span className="cap">{CW_CATEGORY_LABELS.fr[type.category]}</span>
              </div>
            }
            actions={
              <button type="button" className="btn" onClick={() => setEditing({ type, format: null })}>
                + Format
              </button>
            }
          >
            {own.length === 0 ? (
              <Empty title="Aucun format" text="Ce type n'est pas réservable tant qu'il n'a pas de format avec un tarif." />
            ) : (
              <div className="xs">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Format</th>
                      <th>Nature</th>
                      <th>Jours</th>
                      <th className="num">Visiteur</th>
                      <th className="num">Membre</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {own.map((f) => (
                      <tr key={f.id}>
                        <td>
                          <strong>{f.label}</strong>
                          <div className="cap">{formatDetail(f)}</div>
                        </td>
                        <td>{NATURE[f.nature]}</td>
                        <td>{weekdaysLabel(f.weekdays)}</td>
                        <td className="num">
                          <PriceCell price={f.prices.find((p) => p.profile === "visitor")} perHour={f.nature === "free"} />
                        </td>
                        <td className="num">
                          {f.prices.some((p) => p.profile === "member") ? (
                            <PriceCell price={f.prices.find((p) => p.profile === "member")} perHour={f.nature === "free"} />
                          ) : f.prices.length ? (
                            <span className="cap">Tarif visiteur</span>
                          ) : (
                            <span className="cap">-</span>
                          )}
                        </td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          <button type="button" className="btn btn-g" onClick={() => setPricing(f)}>
                            Tarifs
                          </button>
                          <button type="button" className="btn btn-g" onClick={() => setEditing({ type, format: f })}>
                            Modifier
                          </button>
                          <button type="button" className="btn btn-g" onClick={() => setArchiving(f)}>
                            Archiver
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        );
      })}
      {editing ? <FormatModal type={editing.type} format={editing.format} onClose={() => setEditing(null)} /> : null}
      {pricing ? <PricesModal format={pricing} offpeakFrom={settings.data?.offpeakFrom ?? null} onClose={() => setPricing(null)} /> : null}
      {archiving ? (
        <ReasonDialog
          title="Archiver le format"
          explanation={`${archiving.label} n'est plus proposé à la réservation. Les réservations déjà faites avec ce format sont conservées.`}
          confirmLabel="Archiver"
          onClose={() => setArchiving(null)}
          onConfirm={async (reason) => {
            await api.post(`/coworking/formats/${archiving.id}/archive`, { reason });
            await client.invalidateQueries({ queryKey: CW_KEYS.formats });
            toast("Format archivé.");
          }}
        />
      ) : null}
    </>
  );
}
