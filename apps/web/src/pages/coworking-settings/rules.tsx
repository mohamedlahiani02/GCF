import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../components/toasts";
import { Card, ErrorBanner, Field, Loading } from "../../components/ui";
import { frDateTime } from "../../lib/format";
import { CW_KEYS, type CwSettings } from "./api";
import { parseInteger, parsePercent, percentText } from "./helpers";

interface Form {
  bookingHorizonDays: string;
  minNoticeMinutes: string;
  maxActiveBookings: string;
  approvalMode: CwSettings["approvalMode"];
  freeCancelHours: string;
  lateCancelFee: string;
  noShowEnabled: boolean;
  noShowGraceMinutes: string;
  requestExpiryHours: string;
  selfSignup: CwSettings["selfSignup"];
  offpeakEnabled: boolean;
  offpeakFrom: string;
  portalEnabled: boolean;
}

const toForm = (s: CwSettings): Form => ({
  bookingHorizonDays: String(s.bookingHorizonDays),
  minNoticeMinutes: String(s.minNoticeMinutes),
  maxActiveBookings: String(s.maxActiveBookings),
  approvalMode: s.approvalMode,
  freeCancelHours: String(s.freeCancelHours),
  lateCancelFee: percentText(s.lateCancelFeeBp),
  noShowEnabled: s.noShowGraceMinutes !== null,
  noShowGraceMinutes: String(s.noShowGraceMinutes ?? 30),
  requestExpiryHours: String(s.requestExpiryHours),
  selfSignup: s.selfSignup,
  offpeakEnabled: s.offpeakFrom !== null,
  offpeakFrom: s.offpeakFrom ?? "18:00",
  portalEnabled: s.portalEnabled,
});

const APPROVAL: Record<CwSettings["approvalMode"], string> = {
  none: "Aucune : toute réservation du portail est confirmée aussitôt",
  visitors: "Visiteurs : les clients sans abonnement en cours envoient une demande",
  all: "Toutes : chaque réservation du portail est une demande à valider",
};
const SIGNUP: Record<CwSettings["selfSignup"], string> = {
  open: "Libre : le compte est actif dès l'inscription",
  validated: "Validée : le compte attend la validation de l'accueil",
  closed: "Fermée : comptes créés sur invitation uniquement",
};

/** The cw_settings rules. Limits on horizon, notice and active bookings apply to the client portal; the staff may override them. */
export function RulesTab() {
  const client = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: CW_KEYS.settings, queryFn: () => api.get<CwSettings>("/coworking/settings") });
  const [v, setV] = useState<Form | null>(null);
  useEffect(() => {
    if (settings.data) setV(toForm(settings.data));
  }, [settings.data]);
  const save = useMutation({
    mutationFn: (body: Omit<CwSettings, "updatedAt">) => api.put<CwSettings>("/coworking/settings", body),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: CW_KEYS.settings });
      toast("Règles du coworking enregistrées.");
    },
  });
  if (settings.error) return <ErrorBanner error={settings.error} retry={() => settings.refetch()} />;
  if (settings.isPending || !v) return <Loading />;
  const set = <K extends keyof Form>(k: K, value: Form[K]) => setV({ ...v, [k]: value });
  const parsed = {
    bookingHorizonDays: parseInteger(v.bookingHorizonDays, 1, 365),
    minNoticeMinutes: parseInteger(v.minNoticeMinutes, 0, 10_080),
    maxActiveBookings: parseInteger(v.maxActiveBookings, 1, 100),
    freeCancelHours: parseInteger(v.freeCancelHours, 0, 720),
    lateCancelFeeBp: parsePercent(v.lateCancelFee),
    noShowGraceMinutes: v.noShowEnabled ? parseInteger(v.noShowGraceMinutes, 5, 240) : null,
    requestExpiryHours: parseInteger(v.requestExpiryHours, 1, 720),
  };
  const errors = {
    bookingHorizonDays: parsed.bookingHorizonDays === null ? "Entre 1 et 365 jours." : null,
    minNoticeMinutes: parsed.minNoticeMinutes === null ? "Entre 0 et 10 080 minutes (7 jours)." : null,
    maxActiveBookings: parsed.maxActiveBookings === null ? "Entre 1 et 100." : null,
    freeCancelHours: parsed.freeCancelHours === null ? "Entre 0 et 720 heures." : null,
    lateCancelFeeBp: parsed.lateCancelFeeBp === null ? "Un pourcentage de 0 à 100, deux décimales au plus." : null,
    noShowGraceMinutes: v.noShowEnabled && parsed.noShowGraceMinutes === null ? "Entre 5 et 240 minutes." : null,
    requestExpiryHours: parsed.requestExpiryHours === null ? "Entre 1 et 720 heures." : null,
    offpeakFrom: v.offpeakEnabled && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.offpeakFrom) ? "Indiquez une heure." : null,
  };
  const valid = Object.values(errors).every((e) => e === null);
  const submit = () => {
    if (!valid) return;
    save.mutate({
      bookingHorizonDays: parsed.bookingHorizonDays!,
      minNoticeMinutes: parsed.minNoticeMinutes!,
      maxActiveBookings: parsed.maxActiveBookings!,
      approvalMode: v.approvalMode,
      freeCancelHours: parsed.freeCancelHours!,
      lateCancelFeeBp: parsed.lateCancelFeeBp!,
      noShowGraceMinutes: parsed.noShowGraceMinutes,
      requestExpiryHours: parsed.requestExpiryHours!,
      selfSignup: v.selfSignup,
      offpeakFrom: v.offpeakEnabled ? v.offpeakFrom : null,
      portalEnabled: v.portalEnabled,
    });
  };
  return (
    <Card
      title="Règles de réservation"
      footer={
        <>
          <span className="cap">Dernière modification le {frDateTime(settings.data.updatedAt)}. Chaque modification est tracée au journal d'audit.</span>
          <button type="button" className="btn btn-p" disabled={!valid || save.isPending} onClick={submit}>
            Enregistrer
          </button>
        </>
      }
    >
      <div className="card-b stack">
        <h3 className="h2">Réservations depuis l'espace client</h3>
        <span className="cap">Ces limites s'appliquent aux réservations faites par les clients. L'accueil peut les dépasser ; le dépassement est noté au journal.</span>
        <div className="grid3">
          <Field
            label="Horizon de réservation (jours)"
            hint="Un client réserve au plus ce nombre de jours à l'avance."
            error={errors.bookingHorizonDays}
          >
            <input
              className="input num"
              type="number"
              min={1}
              max={365}
              value={v.bookingHorizonDays}
              onChange={(e) => set("bookingHorizonDays", e.target.value)}
            />
          </Field>
          <Field label="Délai minimum (minutes)" hint="Temps minimum entre la réservation et le début du créneau." error={errors.minNoticeMinutes}>
            <input
              className="input num"
              type="number"
              min={0}
              max={10080}
              value={v.minNoticeMinutes}
              onChange={(e) => set("minNoticeMinutes", e.target.value)}
            />
          </Field>
          <Field
            label="Réservations en cours par client"
            hint="Nombre maximum de réservations à venir ou en cours pour un même client."
            error={errors.maxActiveBookings}
          >
            <input
              className="input num"
              type="number"
              min={1}
              max={100}
              value={v.maxActiveBookings}
              onChange={(e) => set("maxActiveBookings", e.target.value)}
            />
          </Field>
        </div>
        <h3 className="h2">Validation des demandes</h3>
        <div className="grid2">
          <Field label="Réservations soumises à validation" hint="Un type d'espace peut aussi exiger une validation, quel que soit ce réglage.">
            <select className="input" value={v.approvalMode} onChange={(e) => set("approvalMode", e.target.value as Form["approvalMode"])}>
              {Object.entries(APPROVAL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Expiration d'une demande (heures)"
            hint="Une demande non traitée expire après ce délai, ou au début du créneau s'il arrive avant."
            error={errors.requestExpiryHours}
          >
            <input
              className="input num"
              type="number"
              min={1}
              max={720}
              value={v.requestExpiryHours}
              onChange={(e) => set("requestExpiryHours", e.target.value)}
            />
          </Field>
        </div>
        <h3 className="h2">Annulation et absence</h3>
        <div className="grid3">
          <Field
            label="Annulation gratuite (heures avant le début)"
            hint="Avant ce délai, l'annulation libère le quota et annule l'échéance non payée."
            error={errors.freeCancelHours}
          >
            <input
              className="input num"
              type="number"
              min={0}
              max={720}
              value={v.freeCancelHours}
              onChange={(e) => set("freeCancelHours", e.target.value)}
            />
          </Field>
          <Field
            label="Frais d'annulation tardive (%)"
            hint="Pourcentage du prix facturé après ce délai ; 0 : aucuns frais, le quota consommé reste perdu."
            error={errors.lateCancelFeeBp}
          >
            <input className="input num" inputMode="decimal" value={v.lateCancelFee} onChange={(e) => set("lateCancelFee", e.target.value)} />
          </Field>
          <div className="stack" style={{ gap: 6 }}>
            <label className="row center" style={{ gap: 8 }}>
              <input type="checkbox" className="chk" checked={v.noShowEnabled} onChange={(e) => set("noShowEnabled", e.target.checked)} />
              Marquer « absent » sans arrivée
            </label>
            <Field
              label="Délai avant absence (minutes)"
              hint="Sans arrivée enregistrée ce délai après le début, la réservation passe en absence et l'espace est libéré. Le montant reste dû."
              error={errors.noShowGraceMinutes}
            >
              <input
                className="input num"
                type="number"
                min={5}
                max={240}
                disabled={!v.noShowEnabled}
                value={v.noShowGraceMinutes}
                onChange={(e) => set("noShowGraceMinutes", e.target.value)}
              />
            </Field>
          </div>
        </div>
        <h3 className="h2">Heures creuses</h3>
        <div className="grid3">
          <div className="stack" style={{ gap: 6 }}>
            <label className="row center" style={{ gap: 8 }}>
              <input type="checkbox" className="chk" checked={v.offpeakEnabled} onChange={(e) => set("offpeakEnabled", e.target.checked)} />
              Appliquer un tarif heures creuses
            </label>
            <Field
              label="Heures creuses à partir de"
              hint="Une réservation qui commence à cette heure ou plus tard paie le tarif heures creuses du format, s'il en a un."
              error={errors.offpeakFrom}
            >
              <input
                className="input"
                type="time"
                disabled={!v.offpeakEnabled}
                value={v.offpeakFrom}
                onChange={(e) => set("offpeakFrom", e.target.value)}
              />
            </Field>
          </div>
        </div>
        <h3 className="h2">Espace client</h3>
        <label className="row center" style={{ gap: 8 }}>
          <input type="checkbox" className="chk" checked={v.portalEnabled} onChange={(e) => set("portalEnabled", e.target.checked)} />
          Espace client ouvert : les clients se connectent, consultent le plan et réservent en ligne
        </label>
        <div className="grid2">
          <Field label="Inscription en ligne" hint="Comment un nouveau client obtient son compte sur l'espace client.">
            <select className="input" value={v.selfSignup} onChange={(e) => set("selfSignup", e.target.value as Form["selfSignup"])}>
              {Object.entries(SIGNUP).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <ErrorBanner error={save.error} />
      </div>
    </Card>
  );
}
