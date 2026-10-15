import { computePay, PayrollError, type PayRule } from "@gcf/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../api/client";
import type { GroupRow, Instructor, Study } from "../api/types";
import { useSession } from "../auth/session";
import { usePage } from "../components/shell";
import { useToast } from "../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Kpi, Loading, Modal, PageHeader, ReasonDialog, Segmented, Tabs } from "../components/ui";
import { frDate, frDateTime, percent, tnd, todayIso, tryParseTnd } from "../lib/format";
import { EMPLOYMENT, METHOD, PAY_BASE, PAYROLL, PRESENCE_EFFECT } from "../lib/labels";

type BaseKind = "pct_collections" | "pct_session_tariff" | "fixed_per_session" | "monthly_flat" | "hourly" | "training_flat";
type PresenceKind = "ignore" | "prorata" | "session_due" | "threshold";

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
  valid_from: string;
  valid_to: string | null;
  status: "active" | "archived";
}
interface PeriodRow {
  id: string;
  month: string;
  label: string;
  status: keyof typeof PAYROLL;
  instructors: number;
  total: number;
}
interface PeriodLine {
  id: string;
  groupId: string | null;
  groupName: string | null;
  rule: RuleRow;
  base: number;
  rateNumerator: number;
  rateDenominator: number;
  amount: number;
  details: { sessions: number; minutes: number; collected: number; rateBasisPoints: number | null; error?: string };
}
interface PeriodDetail {
  id: string;
  month: string;
  label: string;
  status: keyof typeof PAYROLL;
  calculatedAt: string | null;
  validatedAt: string | null;
  total: number;
  instructors: {
    id: string;
    firstName: string;
    lastName: string;
    employment: Instructor["employment"];
    calculated: number;
    adjustments: number;
    net: number;
    lines: PeriodLine[];
    adjustmentLines: { id: string; kind: "bonus" | "deduction"; amount: number; reason: string; createdAt: string }[];
    payslip: { total: number; issuedAt: string; paidOn: string | null; paymentMethod: string | null; paymentReference: string | null } | null;
  }[];
  warnings?: { instructorId: string; groupId: string | null; code: "no_rule" | "no_attendance"; message: string }[];
}
interface TrainingRow {
  id: string;
  title: string;
}

const SCOPE: Record<RuleRow["scope"], string> = { instructor: "Par défaut (intervenant)", study: "Étude", training: "Formation", group: "Groupe" };

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
            <Field label={`${SCOPE[d.scope]} *`} hint="Priorité : groupe, puis étude ou formation, puis règle par défaut de l'intervenant.">
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
            <select className="input" value={d.baseKind} onChange={(e) => set("baseKind", e.target.value as BaseKind)}>
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

function PeriodsTab() {
  const { can } = useSession();
  const navigate = useNavigate();
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const periods = useQuery({ queryKey: ["pay-periods"], queryFn: () => api.get<PeriodRow[]>("/payroll/periods") });
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>("/payroll/periods", { month }),
    onSuccess: (p) => navigate(`/paie/${p.id}`),
  });
  return (
    <Card
      title="Périodes de paie"
      actions={
        can("payroll:calculate") ? (
          <div className="row center" style={{ gap: 8 }}>
            <input className="input" type="month" aria-label="Mois" value={month} onChange={(e) => setMonth(e.target.value)} />
            <button type="button" className="btn btn-p" disabled={!month || create.isPending} onClick={() => create.mutate()}>
              Ouvrir la période
            </button>
          </div>
        ) : null
      }
    >
      <ErrorBanner error={create.error ?? periods.error} />
      {periods.isPending ? (
        <Loading />
      ) : periods.data?.length === 0 ? (
        <Empty title="Aucune période" text="Ouvrez le mois à payer, puis lancez le calcul." />
      ) : (
        <div className="xs">
          <table className="tbl">
            <thead>
              <tr>
                <th>Mois</th>
                <th>Statut</th>
                <th>Intervenants</th>
                <th className="num">Total (TND)</th>
              </tr>
            </thead>
            <tbody>
              {periods.data?.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => navigate(`/paie/${p.id}`)}>
                  <td>
                    <Link to={`/paie/${p.id}`} onClick={(e) => e.stopPropagation()}>
                      {p.label}
                    </Link>
                  </td>
                  <td>
                    <Badge tone={PAYROLL[p.status]!.tone}>{PAYROLL[p.status]!.label}</Badge>
                  </td>
                  <td>{p.instructors}</td>
                  <td className="num">{tnd(p.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function PayrollPage() {
  usePage(["Paie"]);
  const [params, setParams] = useSearchParams();
  const tab = params.get("onglet") === "regles" || params.get("intervenant") ? "rules" : "periods";
  return (
    <>
      <PageHeader title="Paie des intervenants" subtitle="Paie = Base × facteur de présence, calculée sur les séances tenues et validées" />
      <Tabs
        value={tab}
        onChange={(t) => setParams(t === "rules" ? { onglet: "regles" } : {})}
        tabs={[
          { value: "periods", label: "Périodes" },
          { value: "rules", label: "Règles de rémunération" },
        ]}
      />
      {tab === "periods" ? <PeriodsTab /> : <RulesTab />}
    </>
  );
}

/* Period */

function AdjustmentModal({ periodId, instructor, onClose }: { periodId: string; instructor: PeriodDetail["instructors"][number] | null; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const instructors = useQuery({ queryKey: ["instructors"], queryFn: () => api.get<Instructor[]>("/instructors") });
  const [instructorId, setInstructorId] = useState(instructor?.id ?? "");
  const [kind, setKind] = useState<"bonus" | "deduction">("bonus");
  const [amountText, setAmountText] = useState("");
  const [reason, setReason] = useState("");
  const amount = tryParseTnd(amountText);
  const save = useMutation({
    mutationFn: () => api.post(`/payroll/periods/${periodId}/adjustments`, { instructorId, kind, amount, reason: reason.trim() }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["pay-period", periodId] });
      toast(kind === "bonus" ? "Prime ajoutée." : "Retenue ajoutée.");
      onClose();
    },
  });
  return (
    <Modal
      title="Ajustement de paie"
      onClose={onClose}
      footer={
        <>
          <span className="cap">Tracé au journal d'audit</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-p"
              disabled={!instructorId || amount === null || amount <= 0 || !reason.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              Ajouter
            </button>
          </div>
        </>
      }
    >
      <Field label="Intervenant">
        <select className="input" value={instructorId} onChange={(e) => setInstructorId(e.target.value)}>
          <option value="">Choisir</option>
          {(instructors.data ?? []).map((i) => (
            <option key={i.id} value={i.id}>
              {i.lastName} {i.firstName}
            </option>
          ))}
        </select>
      </Field>
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
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

function PayModal({ periodId, instructor, onClose }: { periodId: string; instructor: PeriodDetail["instructors"][number]; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [paidOn, setPaidOn] = useState(todayIso());
  const [method, setMethod] = useState<"cash" | "transfer" | "cheque">("transfer");
  const [reference, setReference] = useState("");
  const pay = useMutation({
    mutationFn: () =>
      api.post(`/payroll/periods/${periodId}/payslips/${instructor.id}/pay`, { paidOn, method, ...(reference.trim() ? { reference: reference.trim() } : {}) }),
    onSuccess: async () => {
      await client.invalidateQueries();
      toast("Paiement de l'intervenant enregistré.");
      onClose();
    },
  });
  return (
    <Modal
      title={`Payer ${instructor.firstName} ${instructor.lastName}`}
      onClose={onClose}
      footer={
        <>
          <span className="cap">Net à payer : {tnd(instructor.net)} TND</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!paidOn || pay.isPending} onClick={() => pay.mutate()}>
              Marquer payé
            </button>
          </div>
        </>
      }
    >
      <Field label="Date du paiement">
        <input className="input" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
      </Field>
      <Segmented
        label="Mode"
        value={method}
        onChange={setMethod}
        options={(["transfer", "cash", "cheque"] as const).map((m) => ({ value: m, label: METHOD[m] ?? m }))}
      />
      <Field label="Référence (facultatif)">
        <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
      </Field>
      <ErrorBanner error={pay.error} />
    </Modal>
  );
}

export function PayPeriodPage() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const client = useQueryClient();
  const toast = useToast();
  const [warnings, setWarnings] = useState<PeriodDetail["warnings"]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState<PeriodDetail["instructors"][number] | null | "new">(null);
  const [paying, setPaying] = useState<PeriodDetail["instructors"][number] | null>(null);
  const [confirmValidate, setConfirmValidate] = useState(false);
  const period = useQuery({ queryKey: ["pay-period", id], queryFn: () => api.get<PeriodDetail>(`/payroll/periods/${id}`) });
  const instructors = useQuery({ queryKey: ["instructors"], queryFn: () => api.get<Instructor[]>("/instructors") });
  usePage(["Paie", period.data ? `Paie de ${period.data.label}` : "Période"]);
  const calculate = useMutation({
    mutationFn: () => api.post<PeriodDetail>(`/payroll/periods/${id}/calculate`),
    onSuccess: async (p) => {
      setWarnings(p.warnings ?? []);
      await client.invalidateQueries({ queryKey: ["pay-period", id] });
      await client.invalidateQueries({ queryKey: ["pay-periods"] });
      toast("Paie calculée.");
    },
  });
  const validate = useMutation({
    mutationFn: () => api.post(`/payroll/periods/${id}/validate`),
    onSuccess: async () => {
      await client.invalidateQueries();
      setConfirmValidate(false);
      toast("Période validée. Les bulletins sont émis.");
    },
  });
  if (period.isPending) return <Loading />;
  if (period.error) return <ErrorBanner error={period.error} retry={() => period.refetch()} />;
  const p = period.data;
  const locked = p.status === "validated" || p.status === "paid";
  const nameOf = (instructorId: string) => {
    const i = instructors.data?.find((x) => x.id === instructorId);
    return i ? `${i.firstName} ${i.lastName}` : "";
  };
  return (
    <>
      <PageHeader
        title={`Paie de ${p.label}`}
        subtitle={
          <span className="row center" style={{ gap: 8 }}>
            <Badge tone={PAYROLL[p.status]!.tone}>{PAYROLL[p.status]!.label}</Badge>
            {p.calculatedAt ? <span>Calculée le {frDateTime(p.calculatedAt)}</span> : null}
            {p.validatedAt ? <span>· validée le {frDateTime(p.validatedAt)}</span> : null}
          </span>
        }
        actions={
          can("payroll:calculate") && !locked ? (
            <>
              <button type="button" className="btn" onClick={() => setAdjusting("new")}>
                + Prime ou retenue
              </button>
              <button type="button" className="btn" disabled={calculate.isPending} onClick={() => calculate.mutate()}>
                {p.status === "draft" ? "Calculer" : "Recalculer"}
              </button>
              <button type="button" className="btn btn-p" disabled={p.status !== "calculated"} onClick={() => setConfirmValidate(true)}>
                Valider la période
              </button>
            </>
          ) : null
        }
      />
      <div className="grid4">
        <Kpi label="Total net" value={<span className="num">{tnd(p.total)}</span>} sub="TND" />
        <Kpi label="Intervenants" value={p.instructors.length} />
        <Kpi label="Bulletins payés" value={`${p.instructors.filter((i) => i.payslip?.paidOn).length}/${p.instructors.length}`} />
        <Kpi
          label="Ajustements"
          value={<span className="num">{tnd(p.instructors.reduce((s, i) => s + i.adjustments, 0))}</span>}
          sub="TND (primes moins retenues)"
        />
      </div>
      <ErrorBanner error={calculate.error ?? validate.error} />
      {warnings?.length ? (
        <div className="ban ban-amber" style={{ flexDirection: "column", alignItems: "flex-start" }}>
          <strong>Points à vérifier</strong>
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>
                {nameOf(w.instructorId)} :{" "}
                {w.code === "no_rule" ? "aucune règle de rémunération ne s'applique, rien n'est calculé." : "aucune présence validée, le taux est indéfini."}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Card title="Intervenants">
        {p.instructors.length === 0 ? (
          <Empty
            title={p.status === "draft" ? "Période non calculée" : "Aucune ligne de paie"}
            text="Le calcul porte sur les séances tenues dont la feuille est validée."
          />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Intervenant</th>
                  <th className="num">Calculé</th>
                  <th className="num">Ajustements</th>
                  <th className="num">Net (TND)</th>
                  <th>Bulletin</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {p.instructors.map((i) => (
                  <Fragment key={i.id}>
                    <tr className="clickable" onClick={() => setOpen(open === i.id ? null : i.id)} aria-expanded={open === i.id}>
                      <td>
                        {open === i.id ? "▾" : "▸"} {i.lastName} {i.firstName}
                        <div className="cap">{EMPLOYMENT[i.employment]}</div>
                      </td>
                      <td className="num">{tnd(i.calculated)}</td>
                      <td className="num">{tnd(i.adjustments)}</td>
                      <td className="num">
                        <strong>{tnd(i.net)}</strong>
                      </td>
                      <td>
                        {i.payslip ? (
                          i.payslip.paidOn ? (
                            <Badge tone="green">Payé le {frDate(i.payslip.paidOn)}</Badge>
                          ) : (
                            <Badge tone="teal">Émis</Badge>
                          )
                        ) : (
                          <Badge tone="neutral">Non émis</Badge>
                        )}
                      </td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                        {i.payslip ? (
                          <a className="btn btn-g" href={api.fileUrl(`/payroll/periods/${id}/payslips/${i.id}/pdf`)} target="_blank" rel="noreferrer">
                            Bulletin PDF
                          </a>
                        ) : null}
                        {i.payslip && !i.payslip.paidOn && can("payroll:calculate") ? (
                          <button type="button" className="btn btn-g" onClick={() => setPaying(i)}>
                            Payer
                          </button>
                        ) : null}
                      </td>
                    </tr>
                    {open === i.id ? (
                      <tr>
                        <td colSpan={6} style={{ background: "var(--soft)" }}>
                          <table className="tbl">
                            <tbody>
                              {i.lines.map((l) => (
                                <tr key={l.id}>
                                  <td>{l.groupId ? <Link to={`/groupes/${l.groupId}`}>{l.groupName}</Link> : "Forfait mensuel"}</td>
                                  <td>
                                    {describeBase(l.rule)}
                                    <div className="cap">
                                      {describePresence(l.rule)} · {l.details.sessions} séance(s) · présence {percent(l.details.rateBasisPoints)}
                                      {l.details.error ? ` · ${l.details.error}` : ""}
                                    </div>
                                  </td>
                                  <td className="num">base {tnd(l.base)}</td>
                                  <td className="num">× {percent(Math.round((l.rateNumerator * 10_000) / l.rateDenominator))}</td>
                                  <td className="num">{tnd(l.amount)}</td>
                                </tr>
                              ))}
                              {i.adjustmentLines.map((a) => (
                                <tr key={a.id}>
                                  <td>{a.kind === "bonus" ? "Prime" : "Retenue"}</td>
                                  <td colSpan={3}>{a.reason}</td>
                                  <td className="num">{a.kind === "bonus" ? tnd(a.amount) : `-${tnd(a.amount)}`}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {can("payroll:calculate") && !locked ? (
                            <button type="button" className="btn btn-g" onClick={() => setAdjusting(i)}>
                              + Prime ou retenue pour {i.firstName}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {adjusting ? <AdjustmentModal periodId={id} instructor={adjusting === "new" ? null : adjusting} onClose={() => setAdjusting(null)} /> : null}
      {paying ? <PayModal periodId={id} instructor={paying} onClose={() => setPaying(null)} /> : null}
      {confirmValidate ? (
        <Modal
          title="Valider la période"
          onClose={() => setConfirmValidate(false)}
          footer={
            <>
              <span />
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn" onClick={() => setConfirmValidate(false)}>
                  Retour
                </button>
                <button type="button" className="btn btn-p" disabled={validate.isPending} onClick={() => validate.mutate()}>
                  Valider et émettre les bulletins
                </button>
              </div>
            </>
          }
        >
          <p>
            Total net : <strong>{tnd(p.total)} TND</strong> pour {p.instructors.length} intervenant(s).
          </p>
          <p className="cap">Une fois validée, la période ne peut plus être recalculée ni ajustée. Chaque ligne garde la copie de la règle appliquée.</p>
          <ErrorBanner error={validate.error} />
        </Modal>
      ) : null}
    </>
  );
}
