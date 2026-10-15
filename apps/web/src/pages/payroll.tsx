import { computePay, PayrollError, type PayRule } from "@gcf/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../api/client";
import type { GroupRow, Instructor, Study } from "../api/types";
import { useSession } from "../auth/session";
import { usePage } from "../components/shell";
import { useToast } from "../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Kpi, Loading, Modal, PageHeader, ReasonDialog, Segmented, Tabs } from "../components/ui";
import { errorMessage } from "../lib/errors";
import { frDate, frDateTime, frTime, monthLabel, percent, tnd, todayIso, tryParseTnd } from "../lib/format";
import { EMPLOYMENT, METHOD, PAY_BASE, PRESENCE_EFFECT } from "../lib/labels";

type BaseKind = "pct_collections" | "pct_session_tariff" | "fixed_per_session" | "monthly_flat" | "hourly" | "training_flat";
type PresenceKind = "ignore" | "prorata" | "session_due" | "threshold";
type Periodicity = "session" | "month" | "training";

/** When a rule's items fall due; the first rhythm of each base is its default. */
export const PERIODICITY: Record<Periodicity, string> = {
  session: "Par séance, dès la validation des présences",
  month: "Par mois, à partir du dernier jour du mois",
  training: "À la fin de la formation (date de fin du groupe)",
};
const PERIODICITIES: Record<BaseKind, Periodicity[]> = {
  fixed_per_session: ["session", "month"],
  pct_session_tariff: ["session", "month"],
  hourly: ["month", "session"],
  pct_collections: ["month"],
  monthly_flat: ["month"],
  training_flat: ["training"],
};

interface RuleRow {
  id: string;
  instructor_id: string;
  scope: "instructor" | "study" | "training" | "group";
  study_id: string | null;
  training_id: string | null;
  group_id: string | null;
  base_kind: BaseKind;
  basis_points: number | null;
  amount: number | null;
  collection_basis: "collected" | "invoiced" | null;
  presence_kind: PresenceKind;
  min_rate_basis_points: number | null;
  floor_amount: number | null;
  prorata_above: boolean | null;
  periodicity: Periodicity;
  valid_from: string;
  valid_to: string | null;
  status: "active" | "archived";
}
interface TrainingRow {
  id: string;
  title: string;
}

const SCOPE: Record<RuleRow["scope"], string> = { instructor: "Par défaut (intervenant)", study: "Cours particulier", training: "Formation", group: "Groupe" };

export function describeBase(r: Pick<RuleRow, "base_kind" | "basis_points" | "amount" | "collection_basis">): string {
  switch (r.base_kind) {
    case "pct_collections":
      return `${percent(r.basis_points)} des montants ${r.collection_basis === "invoiced" ? "facturés" : "encaissés"} du groupe`;
    case "pct_session_tariff":
      return `${percent(r.basis_points)} d'un tarif de séance de ${tnd(r.amount)} TND, par séance tenue`;
    case "fixed_per_session":
      return `${tnd(r.amount)} TND par séance tenue`;
    case "monthly_flat":
      return `Forfait de ${tnd(r.amount)} TND par mois`;
    case "hourly":
      return `${tnd(r.amount)} TND de l'heure`;
    case "training_flat":
      return `Forfait de ${tnd(r.amount)} TND pour la formation`;
  }
}

export function describePresence(r: Pick<RuleRow, "presence_kind" | "min_rate_basis_points" | "floor_amount" | "prorata_above">): string {
  if (r.presence_kind !== "threshold") return PRESENCE_EFFECT[r.presence_kind] ?? r.presence_kind;
  return `Seuil ${percent(r.min_rate_basis_points)} : en dessous ${r.floor_amount !== null ? `plancher de ${tnd(r.floor_amount)} TND` : "rien"}, au-dessus ${r.prorata_above ? "au prorata" : "100 %"}`;
}

/* Rule editor with live simulation */

interface RuleDraft {
  instructorId: string;
  scope: RuleRow["scope"];
  scopeId: string;
  baseKind: BaseKind;
  percentText: string;
  amountText: string;
  collectionBasis: "collected" | "invoiced";
  presenceKind: PresenceKind;
  minRateText: string;
  floorText: string;
  prorataAbove: boolean;
  periodicity: Periodicity;
  validFrom: string;
  validTo: string;
}

const percentToBp = (text: string): number | null => {
  const n = Number(text.replace(",", "."));
  return text.trim() !== "" && Number.isFinite(n) && n > 0 && n <= 100 ? Math.round(n * 100) : null;
};

function RuleModal({ instructors, initialInstructorId, onClose }: { instructors: Instructor[]; initialInstructorId: string; onClose: () => void }) {
  const toast = useToast();
  const client = useQueryClient();
  const studies = useQuery({ queryKey: ["studies"], queryFn: () => api.get<Study[]>("/catalogue/studies") });
  const trainings = useQuery({ queryKey: ["trainings"], queryFn: () => api.get<TrainingRow[]>("/catalogue/trainings") });
  const groups = useQuery({ queryKey: ["groups", null, null, "active"], queryFn: () => api.get<GroupRow[]>("/groups") });
  const [d, setD] = useState<RuleDraft>({
    instructorId: initialInstructorId,
    scope: "group",
    scopeId: "",
    baseKind: "pct_collections",
    percentText: "60",
    amountText: "",
    collectionBasis: "collected",
    presenceKind: "prorata",
    minRateText: "50",
    floorText: "",
    prorataAbove: false,
    periodicity: "month",
    validFrom: `${todayIso().slice(0, 7)}-01`,
    validTo: "",
  });
  const set = <K extends keyof RuleDraft>(k: K, v: RuleDraft[K]) => setD((o) => ({ ...o, [k]: v }));
  const [sim, setSim] = useState({ collected: "1000", sessions: "8", minutes: "720", rate: "85" });

  const usesPercent = d.baseKind === "pct_collections" || d.baseKind === "pct_session_tariff";
  const usesAmount = d.baseKind !== "pct_collections";
  const basisPoints = usesPercent ? percentToBp(d.percentText) : null;
  const amount = usesAmount ? tryParseTnd(d.amountText) : null;
  const minRate = d.presenceKind === "threshold" ? percentToBp(d.minRateText) : null;
  const floor = d.presenceKind === "threshold" && d.floorText.trim() ? tryParseTnd(d.floorText) : null;
  const floorInvalid = d.presenceKind === "threshold" && d.floorText.trim() !== "" && floor === null;
  const valid =
    !!d.instructorId &&
    (d.scope === "instructor" || !!d.scopeId) &&
    (!usesPercent || basisPoints !== null) &&
    (!usesAmount || (amount !== null && amount >= 0)) &&
    (d.presenceKind !== "threshold" || minRate !== null) &&
    !floorInvalid &&
    !!d.validFrom &&
    (!d.validTo || d.validTo >= d.validFrom) &&
    !(d.baseKind === "training_flat" && d.scope === "study");

  const simulation = (() => {
    if (!valid) return null;
    const collected = tryParseTnd(sim.collected) ?? 0;
    const sessions = Math.max(0, Math.trunc(Number(sim.sessions) || 0));
    const minutes = Math.max(0, Math.trunc(Number(sim.minutes) || 0));
    const rateBp = sim.rate.trim() === "" ? null : (percentToBp(sim.rate) ?? (Number(sim.rate) === 0 ? 0 : null));
    const base: PayRule["base"] =
      d.baseKind === "pct_collections"
        ? { kind: "pct_collections", basisPoints: basisPoints!, collected }
        : d.baseKind === "pct_session_tariff"
          ? { kind: "pct_session_tariff", basisPoints: basisPoints!, sessionTariff: amount!, sessionsHeld: sessions }
          : d.baseKind === "fixed_per_session"
            ? { kind: "fixed_per_session", amountPerSession: amount!, sessionsHeld: sessions }
            : d.baseKind === "hourly"
              ? { kind: "hourly", hourlyRate: amount!, minutesDelivered: minutes }
              : { kind: d.baseKind, amount: amount! };
    const presence: PayRule["presence"] =
      d.presenceKind === "threshold"
        ? { kind: "threshold", minRateBasisPoints: minRate!, prorataAbove: d.prorataAbove, ...(floor !== null ? { floor } : {}) }
        : { kind: d.presenceKind };
    try {
      return { result: computePay({ base, presence }, rateBp === null ? { numerator: 0, denominator: 0 } : { numerator: rateBp, denominator: 10_000 }) };
    } catch (error) {
      if (error instanceof PayrollError) return { error: "Taux de présence indéfini : aucune présence d'élève comptée sur la période." };
      throw error;
    }
  })();

  const save = useMutation({
    mutationFn: () =>
      api.post("/payroll/rules", {
        instructorId: d.instructorId,
        scope: d.scope,
        ...(d.scope !== "instructor" ? { scopeId: d.scopeId } : {}),
        baseKind: d.baseKind,
        ...(usesPercent ? { basisPoints } : {}),
        ...(usesAmount ? { amount } : {}),
        ...(d.baseKind === "pct_collections" ? { collectionBasis: d.collectionBasis } : {}),
        presenceKind: d.presenceKind,
        periodicity: d.periodicity,
        ...(d.presenceKind === "threshold"
          ? { minRateBasisPoints: minRate, prorataAbove: d.prorataAbove, ...(floor !== null ? { floorAmount: floor } : {}) }
          : {}),
        validFrom: d.validFrom,
        ...(d.validTo ? { validTo: d.validTo } : {}),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["pay-rules"] });
      toast("Règle enregistrée. Elle s'applique aux prochains calculs de paie.");
      onClose();
    },
  });

  const scopeOptions =
    d.scope === "study"
      ? (studies.data ?? []).filter((s) => s.status === "active").map((s) => ({ id: s.id, label: s.name }))
      : d.scope === "training"
        ? (trainings.data ?? []).map((t) => ({ id: t.id, label: t.title }))
        : d.scope === "group"
          ? (groups.data ?? []).filter((g) => g.instructorId === d.instructorId).map((g) => ({ id: g.id, label: g.name }))
          : [];

  return (
    <Modal
      wide
      title="Nouvelle règle de rémunération"
      onClose={onClose}
      footer={
        <>
          <span className="cap">Une règle n'est jamais modifiée : une nouvelle règle remplace l'ancienne à sa date d'effet</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
              Enregistrer la règle
            </button>
          </div>
        </>
      }
    >
      <div className="grid2" style={{ alignItems: "start" }}>
        <div className="stack">
          <div className="grid2">
            <Field label="Intervenant *">
              <select className="input" value={d.instructorId} onChange={(e) => (set("instructorId", e.target.value), set("scopeId", ""))}>
                <option value="">Choisir</option>
                {instructors
                  .filter((i) => i.status === "active")
                  .map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.lastName} {i.firstName}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="S'applique à">
              <select className="input" value={d.scope} onChange={(e) => (set("scope", e.target.value as RuleRow["scope"]), set("scopeId", ""))}>
                {(Object.keys(SCOPE) as RuleRow["scope"][]).map((s) => (
                  <option key={s} value={s}>
                    {SCOPE[s]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {d.scope !== "instructor" ? (
            <Field label={`${SCOPE[d.scope]} *`} hint="Priorité : groupe, puis cours particulier ou formation, puis règle par défaut de l'intervenant.">
              <select className="input" value={d.scopeId} onChange={(e) => set("scopeId", e.target.value)}>
                <option value="">Choisir</option>
                {scopeOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field label="Base de calcul">
            <select
              className="input"
              value={d.baseKind}
              onChange={(e) => {
                const kind = e.target.value as BaseKind;
                setD((o) => ({ ...o, baseKind: kind, periodicity: PERIODICITIES[kind][0]! }));
              }}
            >
              {(Object.keys(PAY_BASE) as BaseKind[]).map((b) => (
                <option key={b} value={b} disabled={b === "training_flat" && d.scope === "study"}>
                  {PAY_BASE[b]}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid2">
            {usesPercent ? (
              <Field label="Pourcentage *" error={d.percentText && basisPoints === null ? "Entre 0 et 100" : null}>
                <input className="input num" inputMode="decimal" value={d.percentText} onChange={(e) => set("percentText", e.target.value)} />
              </Field>
            ) : null}
            {usesAmount ? (
              <Field
                label={
                  d.baseKind === "pct_session_tariff"
                    ? "Tarif de séance (TND) *"
                    : d.baseKind === "hourly"
                      ? "Taux horaire (TND) *"
                      : d.baseKind === "fixed_per_session"
                        ? "Montant par séance (TND) *"
                        : "Montant (TND) *"
                }
                error={d.amountText && amount === null ? "Montant invalide" : null}
              >
                <input className="input num" inputMode="decimal" value={d.amountText} onChange={(e) => set("amountText", e.target.value)} />
              </Field>
            ) : null}
            {d.baseKind === "pct_collections" ? (
              <Field label="Montants pris en compte">
                <select className="input" value={d.collectionBasis} onChange={(e) => set("collectionBasis", e.target.value as RuleDraft["collectionBasis"])}>
                  <option value="collected">Encaissés dans le mois</option>
                  <option value="invoiced">Facturés pour le mois</option>
                </select>
              </Field>
            ) : null}
          </div>
          <Field label="Rythme de calcul et de paiement" hint="Chaque élément est calculé, validé et réglé séparément, sans attendre les autres intervenants.">
            <select className="input" value={d.periodicity} onChange={(e) => set("periodicity", e.target.value as Periodicity)}>
              {PERIODICITIES[d.baseKind].map((p) => (
                <option key={p} value={p}>
                  {PERIODICITY[p]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Effet de la présence des élèves">
            <select className="input" value={d.presenceKind} onChange={(e) => set("presenceKind", e.target.value as PresenceKind)}>
              {(Object.keys(PRESENCE_EFFECT) as PresenceKind[]).map((p) => (
                <option key={p} value={p}>
                  {PRESENCE_EFFECT[p]}
                </option>
              ))}
            </select>
          </Field>
          {d.presenceKind === "threshold" ? (
            <div className="grid2">
              <Field label="Taux minimum (%) *" error={d.minRateText && minRate === null ? "Entre 0 et 100" : null}>
                <input className="input num" inputMode="decimal" value={d.minRateText} onChange={(e) => set("minRateText", e.target.value)} />
              </Field>
              <Field label="Plancher sous le seuil (TND)" hint="Vide : rien n'est payé sous le seuil." error={floorInvalid ? "Montant invalide" : null}>
                <input className="input num" inputMode="decimal" value={d.floorText} onChange={(e) => set("floorText", e.target.value)} />
              </Field>
              <label className="row center" style={{ gap: 8 }}>
                <input type="checkbox" className="chk" checked={d.prorataAbove} onChange={(e) => set("prorataAbove", e.target.checked)} /> Au-dessus du seuil,
                payer au prorata (sinon 100 %)
              </label>
            </div>
          ) : null}
          <div className="grid2">
            <Field label="En vigueur à partir du *">
              <input className="input" type="date" value={d.validFrom} onChange={(e) => set("validFrom", e.target.value)} />
            </Field>
            <Field label="Jusqu'au" error={d.validTo && d.validTo < d.validFrom ? "Date antérieure au début" : null}>
              <input className="input" type="date" value={d.validTo} onChange={(e) => set("validTo", e.target.value)} />
            </Field>
          </div>
        </div>
        <div className="card" style={{ background: "var(--soft)" }}>
          <div className="card-h">
            <h3 className="h2">Simulateur</h3>
          </div>
          <div className="card-b stack">
            <span className="cap">Même calcul que la paie : Paie = Base × facteur de présence. Les séances annulées ne sont jamais comptées.</span>
            <div className="grid2">
              {d.baseKind === "pct_collections" ? (
                <Field label="Montant du groupe (TND)">
                  <input className="input num" inputMode="decimal" value={sim.collected} onChange={(e) => setSim({ ...sim, collected: e.target.value })} />
                </Field>
              ) : null}
              {d.baseKind === "pct_session_tariff" || d.baseKind === "fixed_per_session" ? (
                <Field label="Séances tenues">
                  <input className="input num" type="number" min={0} value={sim.sessions} onChange={(e) => setSim({ ...sim, sessions: e.target.value })} />
                </Field>
              ) : null}
              {d.baseKind === "hourly" ? (
                <Field label="Minutes assurées">
                  <input className="input num" type="number" min={0} value={sim.minutes} onChange={(e) => setSim({ ...sim, minutes: e.target.value })} />
                </Field>
              ) : null}
              <Field label="Taux de présence (%)" hint="Vide : aucune présence comptée">
                <input className="input num" inputMode="decimal" value={sim.rate} onChange={(e) => setSim({ ...sim, rate: e.target.value })} />
              </Field>
            </div>
            {simulation === null ? (
              <span className="cap">Complétez la règle pour simuler.</span>
            ) : "error" in simulation ? (
              <div className="ban ban-amber">
                <span>{simulation.error}</span>
              </div>
            ) : simulation.result ? (
              <table className="tbl">
                <tbody>
                  <tr>
                    <td>Base</td>
                    <td className="num">{tnd(simulation.result.base)} TND</td>
                  </tr>
                  <tr>
                    <td>Facteur de présence</td>
                    <td className="num">{percent(Math.round((simulation.result.factor.numerator * 10_000) / simulation.result.factor.denominator))}</td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr>
                    <td>Paie</td>
                    <td className="num">{tnd(simulation.result.amount)} TND</td>
                  </tr>
                </tfoot>
              </table>
            ) : null}
          </div>
        </div>
      </div>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

function RulesTab() {
  const { can } = useSession();
  const client = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const instructorId = params.get("intervenant") ?? "";
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<RuleRow | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const instructors = useQuery({ queryKey: ["instructors"], queryFn: () => api.get<Instructor[]>("/instructors") });
  const rules = useQuery({
    queryKey: ["pay-rules", instructorId],
    queryFn: () => api.get<RuleRow[]>("/payroll/rules", { instructorId: instructorId || undefined }),
  });
  const studies = useQuery({ queryKey: ["studies"], queryFn: () => api.get<Study[]>("/catalogue/studies") });
  const trainings = useQuery({ queryKey: ["trainings"], queryFn: () => api.get<TrainingRow[]>("/catalogue/trainings") });
  const groups = useQuery({ queryKey: ["groups", "all"], queryFn: () => api.get<GroupRow[]>("/groups", { status: "all" }) });
  const nameOf = (id: string) => {
    const i = instructors.data?.find((x) => x.id === id);
    return i ? `${i.lastName} ${i.firstName}` : "";
  };
  const target = (r: RuleRow) =>
    r.scope === "study"
      ? studies.data?.find((s) => s.id === r.study_id)?.name
      : r.scope === "training"
        ? trainings.data?.find((t) => t.id === r.training_id)?.title
        : r.scope === "group"
          ? groups.data?.find((g) => g.id === r.group_id)?.name
          : "Tous ses groupes";
  const rows = (rules.data ?? []).filter((r) => showArchived || r.status === "active");
  return (
    <Card
      title={
        <div className="row center" style={{ gap: 8 }}>
          <select
            className="input"
            style={{ width: 240 }}
            aria-label="Intervenant"
            value={instructorId}
            onChange={(e) => setParams(e.target.value ? { onglet: "regles", intervenant: e.target.value } : { onglet: "regles" })}
          >
            <option value="">Tous les intervenants</option>
            {(instructors.data ?? []).map((i) => (
              <option key={i.id} value={i.id}>
                {i.lastName} {i.firstName}
              </option>
            ))}
          </select>
          <label className="row center" style={{ gap: 6 }}>
            <input type="checkbox" className="chk" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Archivées
          </label>
        </div>
      }
      actions={
        can("payroll:rules") ? (
          <button type="button" className="btn btn-p" onClick={() => setCreating(true)}>
            + Nouvelle règle
          </button>
        ) : null
      }
    >
      <ErrorBanner error={rules.error} retry={() => rules.refetch()} />
      {rules.isPending ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty title="Aucune règle" text="Sans règle applicable, un intervenant n'est pas rémunéré et le calcul le signale." />
      ) : (
        <div className="xs">
          <table className="tbl">
            <thead>
              <tr>
                <th>Intervenant</th>
                <th>Portée</th>
                <th>Base</th>
                <th>Présence</th>
                <th>Rythme</th>
                <th>Validité</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/intervenants/${r.instructor_id}`}>{nameOf(r.instructor_id)}</Link>
                  </td>
                  <td>
                    {SCOPE[r.scope]}
                    <div className="cap">{target(r)}</div>
                  </td>
                  <td>{describeBase(r)}</td>
                  <td>{describePresence(r)}</td>
                  <td>{PERIODICITY[r.periodicity]}</td>
                  <td>
                    {frDate(r.valid_from)}
                    {r.valid_to ? ` au ${frDate(r.valid_to)}` : ", sans fin"} {r.status === "archived" ? <Badge tone="gray">Archivée</Badge> : null}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {can("payroll:rules") && r.status === "active" ? (
                      <button type="button" className="btn btn-g" onClick={() => setArchiving(r)}>
                        Archiver
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating ? <RuleModal instructors={instructors.data ?? []} initialInstructorId={instructorId} onClose={() => setCreating(false)} /> : null}
      {archiving ? (
        <ReasonDialog
          title="Archiver la règle"
          explanation="La règle ne sera plus appliquée aux prochains calculs. Les paies déjà validées gardent la copie de la règle utilisée."
          confirmLabel="Archiver"
          onClose={() => setArchiving(null)}
          onConfirm={async (reason) => {
            await api.post(`/payroll/rules/${archiving.id}/archive`, { reason });
            await client.invalidateQueries({ queryKey: ["pay-rules"] });
            toast("Règle archivée.");
          }}
        />
      ) : null}
    </Card>
  );
}

/* Monthly follow-up: a view, never a global validation */

interface SummaryRow {
  id: string;
  firstName: string;
  lastName: string;
  employment: Instructor["employment"];
  calculated: number;
  validated: number;
  paid: number;
  remaining: number;
  outstanding: number;
  toValidate: number;
  sessionsToCalculate: number;
  groupsWithoutRule: number;
}

function SummaryTab() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const month = params.get("mois") ?? todayIso().slice(0, 7);
  const summary = useQuery({
    queryKey: ["pay-summary", month],
    queryFn: () =>
      api.get<{ instructors: SummaryRow[]; totals: Record<"calculated" | "validated" | "paid" | "remaining" | "outstanding", number> }>("/payroll/summary", {
        month,
      }),
  });
  const t = summary.data?.totals;
  return (
    <>
      <div className="row between center">
        <input
          className="input"
          type="month"
          aria-label="Mois"
          style={{ width: 180 }}
          value={month}
          onChange={(e) => e.target.value && setParams({ mois: e.target.value })}
        />
        <span className="cap">Vue de suivi : chaque intervenant est calculé, validé et réglé séparément, sans validation globale du mois.</span>
      </div>
      {t ? (
        <div className="grid4">
          <Kpi label="Calculé, à valider" value={<span className="num">{tnd(t.calculated)}</span>} sub={`TND, ${monthLabel(month)}`} />
          <Kpi label="Validé" value={<span className="num">{tnd(t.validated)}</span>} sub={`TND, ${monthLabel(month)}`} />
          <Kpi label="Payé" value={<span className="num">{tnd(t.paid)}</span>} sub={`TND, éléments de ${monthLabel(month)}`} />
          <Kpi
            label="Reste à payer"
            value={<span className="num">{tnd(t.outstanding)}</span>}
            sub="TND, tous mois confondus"
            tone={t.outstanding > 0 ? "amber" : undefined}
          />
        </div>
      ) : null}
      <Card title={`Intervenants, ${monthLabel(month)}`}>
        <ErrorBanner error={summary.error} retry={() => summary.refetch()} />
        {summary.isPending ? (
          <Loading />
        ) : summary.data?.instructors.length === 0 ? (
          <Empty title="Aucun intervenant" />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Intervenant</th>
                  <th>À calculer</th>
                  <th className="num">À valider (TND)</th>
                  <th className="num">Validé (TND)</th>
                  <th className="num">Payé (TND)</th>
                  <th className="num">Reste du mois (TND)</th>
                  <th className="num">Reste total (TND)</th>
                </tr>
              </thead>
              <tbody>
                {summary.data?.instructors.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => navigate(`/paie/intervenants/${r.id}?mois=${month}`)}>
                    <td>
                      <Link to={`/paie/intervenants/${r.id}?mois=${month}`} onClick={(e) => e.stopPropagation()}>
                        {r.lastName} {r.firstName}
                      </Link>
                      <div className="cap">{EMPLOYMENT[r.employment]}</div>
                    </td>
                    <td>
                      {r.sessionsToCalculate ? <Badge tone="amber">{r.sessionsToCalculate} séance(s)</Badge> : null}{" "}
                      {r.groupsWithoutRule ? <Badge tone="red">{r.groupsWithoutRule} groupe(s) sans règle</Badge> : null}
                      {!r.sessionsToCalculate && !r.groupsWithoutRule ? <span className="cap">-</span> : null}
                    </td>
                    <td className="num">
                      {tnd(r.calculated)}
                      {r.toValidate ? <div className="cap">{r.toValidate} élément(s)</div> : null}
                    </td>
                    <td className="num">{tnd(r.validated)}</td>
                    <td className="num">{tnd(r.paid)}</td>
                    <td className="num">{tnd(r.remaining)}</td>
                    <td className="num">{r.outstanding ? <strong>{tnd(r.outstanding)}</strong> : tnd(0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

export function PayrollPage() {
  usePage(["Paie"]);
  const [params, setParams] = useSearchParams();
  const tab = params.get("onglet") === "regles" || params.get("intervenant") ? "rules" : "summary";
  return (
    <>
      <PageHeader title="Paie des intervenants" subtitle="Paie = Base × facteur de présence, sur les séances tenues dont les présences sont validées" />
      <Tabs
        value={tab}
        onChange={(t) => setParams(t === "rules" ? { onglet: "regles" } : {})}
        tabs={[
          { value: "summary", label: "Suivi mensuel" },
          { value: "rules", label: "Règles de rémunération" },
        ]}
      />
      {tab === "summary" ? <SummaryTab /> : <RulesTab />}
    </>
  );
}

/* One instructor: items to calculate, validate and settle */

interface PayItem {
  id: string;
  kind: "rule" | "bonus" | "deduction";
  rule: RuleRow | null;
  groupId: string | null;
  groupName: string | null;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  dueOn: string;
  label: string;
  base: number;
  rateNumerator: number;
  rateDenominator: number;
  amount: number;
  details: {
    sessions?: number;
    minutes?: number;
    collected?: number;
    rateBasisPoints?: number | null;
    share?: { mine: number; total: number } | null;
    error?: string;
  };
  status: "calculated" | "validated" | "cancelled";
  reason: string | null;
  calculatedAt: string;
  validatedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  paid: number;
  remaining: number;
  sessions: number;
  earlierMonth: boolean;
}
interface Settlement {
  id: string;
  number: string;
  paidOn: string;
  method: "cash" | "transfer" | "cheque";
  reference: string | null;
  amount: number;
  status: "valid" | "cancelled";
  cancelReason: string | null;
}
interface InstructorPay {
  instructor: { id: string; firstName: string; lastName: string; employment: Instructor["employment"] };
  month: string;
  today: string;
  items: PayItem[];
  settlements: Settlement[];
  rules: RuleRow[];
}
interface CalculationResult {
  created: number;
  unchanged: number;
  replaced: number;
  warnings: { groupName: string | null; code: "no_rule" | "no_attendance" }[];
}

const ITEM_STATUS: Record<PayItem["status"], { label: string; tone: "blue" | "teal" | "gray" }> = {
  calculated: { label: "Calculé", tone: "blue" },
  validated: { label: "Validé", tone: "teal" },
  cancelled: { label: "Annulé", tone: "gray" },
};

/** What the item pays for, in words: base, presence effect, sessions and attendance. */
function perimeter(i: PayItem): string {
  if (i.kind !== "rule" || !i.rule) return i.reason ?? "";
  const parts = [describeBase(i.rule), describePresence(i.rule)];
  if (i.details.sessions !== undefined) parts.push(`${i.details.sessions} séance(s)`);
  if (i.details.share) parts.push(`part de ${i.details.share.mine} séance(s) sur ${i.details.share.total}`);
  if (i.details.rateBasisPoints !== undefined && i.details.rateBasisPoints !== null) parts.push(`présence ${percent(i.details.rateBasisPoints)}`);
  if (i.details.error) parts.push("taux de présence indéfini");
  return parts.join(" · ");
}

function itemState(i: PayItem): { label: string; tone: "blue" | "teal" | "gray" | "green" | "amber" } {
  if (i.status !== "validated") return ITEM_STATUS[i.status];
  if (i.remaining === 0) return { label: "Payé", tone: "green" };
  if (i.paid !== 0) return { label: "Payé en partie", tone: "amber" };
  return ITEM_STATUS.validated;
}

function SettleModal({ instructorId, items, onClose }: { instructorId: string; items: PayItem[]; onClose: () => void }) {
  const toast = useToast();
  const client = useQueryClient();
  const [texts, setTexts] = useState<Record<string, string>>(Object.fromEntries(items.map((i) => [i.id, tnd(Math.abs(i.remaining))])));
  const [paidOn, setPaidOn] = useState(todayIso());
  const [method, setMethod] = useState<"cash" | "transfer" | "cheque">("transfer");
  const [reference, setReference] = useState("");
  const lines = items.map((i) => {
    if (i.amount < 0) return { item: i, amount: i.remaining as number | null };
    const parsed = tryParseTnd(texts[i.id] ?? "");
    return { item: i, amount: parsed !== null && parsed > 0 && parsed <= i.remaining ? parsed : null };
  });
  const valid = lines.every((l) => l.amount !== null);
  const total = lines.reduce((s, l) => s + (l.amount ?? 0), 0);
  const settle = useMutation({
    mutationFn: () =>
      api.post<{ id: string; number: string; amount: number }>("/payroll/settlements", {
        instructorId,
        paidOn,
        method,
        ...(reference.trim() ? { reference: reference.trim() } : {}),
        lines: lines.map((l) => ({ itemId: l.item.id, amount: l.amount })),
      }),
    onSuccess: async (r) => {
      await client.invalidateQueries();
      toast(`Règlement ${r.number} enregistré : ${tnd(r.amount)} TND.`);
      window.open(api.fileUrl(`/payroll/settlements/${r.id}/pdf`), "_blank", "noopener");
      onClose();
    },
  });
  return (
    <Modal
      wide
      title="Régler des éléments de rémunération"
      onClose={onClose}
      footer={
        <>
          <span className="cap">Un justificatif de paiement numéroté est émis</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!valid || total <= 0 || !paidOn || settle.isPending} onClick={() => settle.mutate()}>
              Régler {valid ? `${tnd(total)} TND` : ""}
            </button>
          </div>
        </>
      }
    >
      <div className="card xs">
        <table className="tbl">
          <thead>
            <tr>
              <th>Élément</th>
              <th className="num">Dû</th>
              <th className="num">Déjà payé</th>
              <th className="num">Reste</th>
              <th className="num">Payé maintenant (TND)</th>
            </tr>
          </thead>
          <tbody>
            {lines.map(({ item, amount }) => (
              <tr key={item.id}>
                <td>{item.label}</td>
                <td className="num">{tnd(item.amount)}</td>
                <td className="num">{tnd(item.paid)}</td>
                <td className="num">{tnd(item.remaining)}</td>
                <td className="num">
                  {item.amount < 0 ? (
                    <span title="Une retenue est déduite en totalité">{tnd(item.remaining)}</span>
                  ) : (
                    <input
                      className={`input num${amount === null ? " err" : ""}`}
                      style={{ width: 130 }}
                      inputMode="decimal"
                      aria-label={`Montant payé pour ${item.label}`}
                      value={texts[item.id] ?? ""}
                      onChange={(e) => setTexts({ ...texts, [item.id]: e.target.value })}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4}>Total du règlement</td>
              <td className="num">{tnd(total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {!valid ? <div className="err-text">Chaque montant doit être positif et ne pas dépasser le reste à payer de l'élément.</div> : null}
      <div className="grid3">
        <Field label="Date du paiement">
          <input className="input" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
        <Field label="Mode">
          <select className="input" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            {(["transfer", "cash", "cheque"] as const).map((m) => (
              <option key={m} value={m}>
                {METHOD[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Référence (facultatif)">
          <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      </div>
      <ErrorBanner error={settle.error} />
    </Modal>
  );
}

function AdjustmentModal({ instructorId, month, onClose }: { instructorId: string; month: string; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<"bonus" | "deduction">("bonus");
  const [amountText, setAmountText] = useState("");
  const [reason, setReason] = useState("");
  const amount = tryParseTnd(amountText);
  const save = useMutation({
    mutationFn: () => api.post("/payroll/adjustments", { instructorId, month, kind, amount, reason: reason.trim() }),
    onSuccess: async () => {
      await client.invalidateQueries();
      toast(kind === "bonus" ? "Prime ajoutée : validez-la pour pouvoir la régler." : "Retenue ajoutée : validez-la pour l'appliquer au prochain règlement.");
      onClose();
    },
  });
  return (
    <Modal
      title="Prime ou retenue"
      onClose={onClose}
      footer={
        <>
          <span className="cap">Tracée au journal d'audit</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-p"
              disabled={amount === null || amount <= 0 || !reason.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              Ajouter
            </button>
          </div>
        </>
      }
    >
      <Segmented
        label="Type"
        value={kind}
        onChange={setKind}
        options={[
          { value: "bonus", label: "Prime" },
          { value: "deduction", label: "Retenue" },
        ]}
      />
      <Field label="Montant (TND)" error={amountText && amount === null ? "Montant invalide" : null}>
        <input className="input num" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
      </Field>
      <Field label="Motif (obligatoire)">
        <textarea className="input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <span className="cap">Rattachée au suivi de {monthLabel(month)}.</span>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

function ItemDetailModal({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ["pay-item", itemId],
    queryFn: () =>
      api.get<
        PayItem & {
          sessions: { id: string; groupName: string; startsAt: string; endsAt: string; localDate: string; active: boolean }[];
          settlements: { id: string; number: string; paidOn: string; status: string; amount: number }[];
        }
      >(`/payroll/items/${itemId}`),
  });
  const d = detail.data;
  return (
    <Modal wide title={d ? d.label : "Élément de rémunération"} onClose={onClose}>
      <ErrorBanner error={detail.error} />
      {!d ? (
        <Loading />
      ) : (
        <>
          <div className="grid4">
            <Kpi label="Base" value={<span className="num">{tnd(d.base)}</span>} sub="TND" />
            <Kpi label="Facteur de présence" value={percent(Math.round((d.rateNumerator * 10_000) / d.rateDenominator))} />
            <Kpi label="Montant" value={<span className="num">{tnd(d.amount)}</span>} sub="TND" />
            <Kpi label="Reste à payer" value={<span className="num">{tnd(d.remaining)}</span>} sub={`TND, payé ${tnd(d.paid)}`} />
          </div>
          <div className="cap">{perimeter(d)}</div>
          {d.rule ? (
            <div className="cap">
              Rythme : {PERIODICITY[d.rule.periodicity]}. Période du {frDate(d.periodStart)} au {frDate(d.periodEnd)}, validable dès le {frDate(d.dueOn)}.
            </div>
          ) : null}
          {d.sessions.length ? (
            <div className="card xs">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Séance payée</th>
                    <th>Groupe</th>
                  </tr>
                </thead>
                <tbody>
                  {d.sessions.map((s) => (
                    <tr key={s.id} className={s.active ? "" : "dim"}>
                      <td>
                        <Link to={`/presences/${s.id}`}>
                          {frDate(s.localDate)} {frTime(s.startsAt)}-{frTime(s.endsAt)}
                        </Link>
                      </td>
                      <td>{s.groupName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <div>
            <div className="lab">Historique</div>
            <ol className="tl">
              <li>
                <div className="cap">{frDateTime(d.calculatedAt)}</div>
                <div>{d.kind === "rule" ? "Calculé" : "Saisi"}</div>
              </li>
              {d.validatedAt ? (
                <li>
                  <div className="cap">{frDateTime(d.validatedAt)}</div>
                  <div>Validé</div>
                </li>
              ) : null}
              {d.settlements.map((s) => (
                <li key={s.id}>
                  <div className="cap">{frDate(s.paidOn)}</div>
                  <div>
                    Règlement {s.number} : {tnd(s.amount)} TND {s.status === "cancelled" ? <Badge tone="gray">Annulé</Badge> : null}
                  </div>
                </li>
              ))}
              {d.cancelledAt ? (
                <li>
                  <div className="cap">{frDateTime(d.cancelledAt)}</div>
                  <div>Annulé : {d.cancelReason}</div>
                </li>
              ) : null}
            </ol>
          </div>
        </>
      )}
    </Modal>
  );
}

export function InstructorPayPage() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const toast = useToast();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const month = params.get("mois") ?? todayIso().slice(0, 7);
  const [selected, setSelected] = useState<string[]>([]);
  const [settling, setSettling] = useState<PayItem[] | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [cancelling, setCancelling] = useState<PayItem | null>(null);
  const [cancellingSettlement, setCancellingSettlement] = useState<Settlement | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<CalculationResult["warnings"]>([]);
  const [showCancelled, setShowCancelled] = useState(false);
  const pay = useQuery({ queryKey: ["instructor-pay", id, month], queryFn: () => api.get<InstructorPay>(`/payroll/instructors/${id}`, { month }) });
  const name = pay.data ? `${pay.data.instructor.firstName} ${pay.data.instructor.lastName}` : "Intervenant";
  usePage(["Paie", name]);
  const calculate = useMutation({
    mutationFn: () => api.post<CalculationResult>("/payroll/calculate", { instructorId: id, month }),
    onSuccess: async (r) => {
      setWarnings(r.warnings);
      await client.invalidateQueries();
      toast(`${r.created} élément(s) calculé(s), ${r.unchanged} inchangé(s)${r.replaced ? `, ${r.replaced} recalculé(s)` : ""}.`);
    },
  });
  const validate = useMutation({
    mutationFn: (itemIds: string[]) => api.post<{ validated: number }>("/payroll/items/validate", { itemIds }),
    onSuccess: async (r) => {
      setSelected([]);
      await client.invalidateQueries();
      toast(`${r.validated} élément(s) validé(s).`);
    },
    onError: (error) => toast(errorMessage(error), "error"),
  });
  if (pay.isPending) return <Loading />;
  if (pay.error) return <ErrorBanner error={pay.error} retry={() => pay.refetch()} />;
  const data = pay.data;
  const writable = can("payroll:calculate");
  const visible = data.items.filter((i) => showCancelled || i.status !== "cancelled");
  const current = visible.filter((i) => !i.earlierMonth);
  const earlier = visible.filter((i) => i.earlierMonth);
  const chosen = data.items.filter((i) => selected.includes(i.id));
  const toValidate = chosen.filter((i) => i.status === "calculated" && i.dueOn <= data.today);
  const toSettle = chosen.filter((i) => i.status === "validated" && i.remaining !== 0);
  const sum = (list: PayItem[], pick: (i: PayItem) => number) => list.reduce((s, i) => s + pick(i), 0);
  const active = data.items.filter((i) => i.status !== "cancelled" && !i.earlierMonth);
  const toggle = (itemId: string, on: boolean) => setSelected((list) => (on ? [...list, itemId] : list.filter((x) => x !== itemId)));

  const table = (items: PayItem[]) => (
    <div className="xs">
      <table className="tbl">
        <thead>
          <tr>
            {writable ? <th style={{ width: 32 }} /> : null}
            <th>Élément de rémunération</th>
            <th>Échéance</th>
            <th>Statut</th>
            <th className="num">Montant</th>
            <th className="num">Payé</th>
            <th className="num">Reste</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const state = itemState(i);
            const selectable = (i.status === "calculated" && i.dueOn <= data.today) || (i.status === "validated" && i.remaining !== 0);
            return (
              <tr key={i.id} className={i.status === "cancelled" ? "dim" : selected.includes(i.id) ? "sel" : ""}>
                {writable ? (
                  <td>
                    <input
                      type="checkbox"
                      className="chk"
                      aria-label={i.label}
                      disabled={!selectable}
                      checked={selected.includes(i.id)}
                      onChange={(e) => toggle(i.id, e.target.checked)}
                    />
                  </td>
                ) : null}
                <td>
                  <button type="button" className="btn btn-g" style={{ padding: 0, minHeight: 0, textAlign: "start" }} onClick={() => setDetail(i.id)}>
                    {i.label}
                  </button>
                  <div className="cap">{perimeter(i)}</div>
                  {i.cancelReason ? <div className="cap">Annulé : {i.cancelReason}</div> : null}
                </td>
                <td>
                  {frDate(i.dueOn)}
                  {i.status === "calculated" && i.dueOn > data.today ? <div className="cap">validable dès cette date</div> : null}
                </td>
                <td>
                  <Badge tone={state.tone}>{state.label}</Badge>
                </td>
                <td className="num">{tnd(i.amount)}</td>
                <td className="num">{i.status === "validated" ? tnd(i.paid) : ""}</td>
                <td className="num">{i.status === "validated" ? tnd(i.remaining) : ""}</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  {writable && i.status === "calculated" && i.dueOn <= data.today ? (
                    <button type="button" className="btn btn-g" disabled={validate.isPending} onClick={() => validate.mutate([i.id])}>
                      Valider
                    </button>
                  ) : null}
                  {writable && i.status === "validated" && i.remaining !== 0 ? (
                    <button type="button" className="btn btn-g" onClick={() => setSettling([i])}>
                      Régler
                    </button>
                  ) : null}
                  {writable && (i.status === "calculated" || (i.status === "validated" && i.paid === 0)) ? (
                    <button type="button" className="btn btn-g" onClick={() => setCancelling(i)}>
                      Annuler
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <PageHeader
        title={`Paie de ${name}`}
        subtitle={
          <span className="row center" style={{ gap: 8 }}>
            <span>{EMPLOYMENT[data.instructor.employment]}</span>
            <Link to={`/intervenants/${id}`}>Fiche intervenant</Link>
            <Link to={`/paie?onglet=regles&intervenant=${id}`}>Règles de rémunération</Link>
          </span>
        }
        actions={
          <>
            <input
              className="input"
              type="month"
              aria-label="Mois"
              value={month}
              onChange={(e) => e.target.value && (setParams({ mois: e.target.value }), setSelected([]))}
            />
            {writable ? (
              <>
                <button type="button" className="btn btn-p" disabled={calculate.isPending} onClick={() => calculate.mutate()}>
                  Calculer
                </button>
                <button type="button" className="btn" onClick={() => setAdjusting(true)}>
                  + Prime ou retenue
                </button>
              </>
            ) : null}
          </>
        }
      />
      <div className="grid4">
        <Kpi
          label="Calculé, à valider"
          value={
            <span className="num">
              {tnd(
                sum(
                  active.filter((i) => i.status === "calculated"),
                  (i) => i.amount,
                ),
              )}
            </span>
          }
          sub={`TND, ${monthLabel(month)}`}
        />
        <Kpi
          label="Validé"
          value={
            <span className="num">
              {tnd(
                sum(
                  active.filter((i) => i.status === "validated"),
                  (i) => i.amount,
                ),
              )}
            </span>
          }
          sub="TND"
        />
        <Kpi label="Déjà payé" value={<span className="num">{tnd(sum(active, (i) => i.paid))}</span>} sub="TND" />
        <Kpi
          label="Reste à payer"
          value={
            <span className="num">
              {tnd(
                sum(
                  data.items.filter((i) => i.status === "validated"),
                  (i) => i.remaining,
                ),
              )}
            </span>
          }
          sub="TND, ce mois et les mois précédents"
          tone={data.items.some((i) => i.status === "validated" && i.remaining !== 0) ? "amber" : undefined}
        />
      </div>
      {data.rules.length === 0 ? (
        <div className="ban ban-amber">
          <span>Aucune règle de rémunération en vigueur ce mois-ci : rien ne peut être calculé.</span>
        </div>
      ) : (
        <div className="cap">
          Règles en vigueur :{" "}
          {data.rules.map((r) => `${describeBase(r)} (${SCOPE[r.scope].toLowerCase()}, ${PERIODICITY[r.periodicity].toLowerCase()})`).join(" ; ")}
        </div>
      )}
      {warnings.length ? (
        <div className="ban ban-amber" style={{ flexDirection: "column", alignItems: "flex-start" }}>
          <strong>Points à vérifier</strong>
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>
                {w.groupName ?? "Forfait mensuel"} :{" "}
                {w.code === "no_rule"
                  ? "aucune règle de rémunération ne s'applique, les séances ne sont pas payées."
                  : "aucune présence validée, le taux est indéfini."}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <ErrorBanner error={calculate.error} />
      <Card
        title={`Éléments de ${monthLabel(month)}`}
        actions={
          <>
            <label className="row center" style={{ gap: 6 }}>
              <input type="checkbox" className="chk" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> Historique des annulations
            </label>
            {writable ? (
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={!toValidate.length || validate.isPending}
                  onClick={() => validate.mutate(toValidate.map((i) => i.id))}
                >
                  Valider la sélection ({toValidate.length})
                </button>
                <button type="button" className="btn btn-p" disabled={!toSettle.length} onClick={() => setSettling(toSettle)}>
                  Régler la sélection ({toSettle.length})
                </button>
              </>
            ) : null}
          </>
        }
      >
        {current.length === 0 ? (
          <Empty
            title="Aucun élément ce mois-ci"
            text="« Calculer » produit les éléments dus : chaque séance validée pour une règle à la séance, le mois pour une règle mensuelle, la formation à sa fin."
          />
        ) : (
          table(current)
        )}
      </Card>
      {earlier.length ? <Card title="Reste à payer des mois précédents">{table(earlier)}</Card> : null}
      <Card title="Règlements">
        {data.settlements.length === 0 ? (
          <Empty title="Aucun règlement" />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Numéro</th>
                  <th>Payé le</th>
                  <th>Mode</th>
                  <th className="num">Montant (TND)</th>
                  <th>Statut</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.settlements.map((st) => (
                  <tr key={st.id} className={st.status === "cancelled" ? "dim" : ""}>
                    <td>{st.number}</td>
                    <td>{frDate(st.paidOn)}</td>
                    <td>
                      {METHOD[st.method]}
                      {st.reference ? <div className="cap">{st.reference}</div> : null}
                    </td>
                    <td className="num">{tnd(st.amount)}</td>
                    <td>
                      {st.status === "valid" ? <Badge tone="green">Valide</Badge> : <Badge tone="gray">Annulé</Badge>}
                      {st.cancelReason ? <div className="cap">{st.cancelReason}</div> : null}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <a className="btn btn-g" href={api.fileUrl(`/payroll/settlements/${st.id}/pdf`)} target="_blank" rel="noreferrer">
                        Justificatif PDF
                      </a>
                      {writable && st.status === "valid" ? (
                        <button type="button" className="btn btn-g" onClick={() => setCancellingSettlement(st)}>
                          Annuler
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {settling ? <SettleModal instructorId={id} items={settling} onClose={() => (setSettling(null), setSelected([]))} /> : null}
      {adjusting ? <AdjustmentModal instructorId={id} month={month} onClose={() => setAdjusting(false)} /> : null}
      {detail ? <ItemDetailModal itemId={detail} onClose={() => setDetail(null)} /> : null}
      {cancelling ? (
        <ReasonDialog
          title="Annuler l'élément"
          danger
          explanation={`${cancelling.label} : ${tnd(cancelling.amount)} TND. Ses séances redeviennent à calculer ; l'historique est conservé.`}
          confirmLabel="Annuler l'élément"
          onClose={() => setCancelling(null)}
          onConfirm={async (reason) => {
            await api.post(`/payroll/items/${cancelling.id}/cancel`, { reason });
            await client.invalidateQueries();
            toast("Élément annulé.");
          }}
        />
      ) : null}
      {cancellingSettlement ? (
        <ReasonDialog
          title="Annuler le règlement"
          danger
          explanation={`Règlement ${cancellingSettlement.number} de ${tnd(cancellingSettlement.amount)} TND : les éléments qu'il réglait redeviennent dus. Le justificatif reste archivé.`}
          confirmLabel="Annuler le règlement"
          onClose={() => setCancellingSettlement(null)}
          onConfirm={async (reason) => {
            await api.post(`/payroll/settlements/${cancellingSettlement.id}/cancel`, { reason });
            await client.invalidateQueries();
            toast("Règlement annulé.");
          }}
        />
      ) : null}
    </>
  );
}
