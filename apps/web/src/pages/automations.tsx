import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { usePage } from "../components/shell";
import { useToast } from "../components/toasts";
import { Badge, Card, ErrorBanner, Field, Loading, PageHeader, Segmented } from "../components/ui";
import { frDateTime, parseTnd, tnd, weekdayLabel } from "../lib/format";
import { ROLE } from "../lib/labels";

type Key = "overdue_reminders" | "payroll_month" | "daily_digest" | "mail_item_notice";
type Mode = "off" | "propose" | "auto";
type Role = "admin" | "secretariat" | "accountant" | "editor";
interface Run {
  id: string;
  periodKey: string;
  mode: "propose" | "auto";
  status: "running" | "done" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string | null;
  summary: Record<string, unknown> | null;
  error: string | null;
}
interface Automation {
  key: Key;
  mode: Mode;
  modes: Mode[];
  available: boolean;
  params: Record<string, unknown>;
  updatedAt: string | null;
  updatedByName: string | null;
  runs: Run[];
}

const TEXT: Record<Key, { title: string; text: string; propose?: string; auto: string }> = {
  overdue_reminders: {
    title: "Relances d'impayés de la semaine",
    text: "Chaque semaine, la liste des élèves en retard de paiement, au-delà du délai de grâce du centre.",
    propose: "La liste attend dans Propositions ; un membre du secrétariat la confirme et les e-mails partent.",
    auto: "Les e-mails partent sans confirmation, tracés au journal d'audit.",
  },
  payroll_month: {
    title: "Paie du mois",
    text: "Le mois précédent : les éléments que les règles produisent, et les points à vérifier (prof / formateur sans règle, feuille non validée).",
    propose: "Le calcul attend dans Propositions ; la comptabilité le confirme.",
    auto: "Les éléments sont calculés. Leur validation reste toujours une décision de la comptabilité.",
  },
  daily_digest: {
    title: "Programme du lendemain",
    text: "Chaque jour, par e-mail : les séances et les réservations du lendemain, et les propositions en attente.",
    auto: "L'e-mail part chaque jour à l'heure choisie.",
  },
  mail_item_notice: {
    title: "Avis de courrier reçu (coworking)",
    text: "Dès qu'un courrier est enregistré pour un client domicilié, le client est prévenu par e-mail.",
    auto: "L'avis part à l'enregistrement, sans passer par « Prévenir ».",
  },
};
const MODE_LABEL: Record<Mode, string> = { off: "Désactivé", propose: "À confirmer", auto: "Automatique" };
const RUN_STATUS: Record<Run["status"], { label: string; tone: "gray" | "amber" | "green" | "red" }> = {
  skipped: { label: "Non lancée (activation)", tone: "gray" },
  running: { label: "En cours", tone: "amber" },
  done: { label: "Terminée", tone: "green" },
  failed: { label: "Échec", tone: "red" },
};
const ROLES: Role[] = ["admin", "secretariat", "accountant", "editor"];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

function HourSelect({ value, onChange, label }: { value: number; onChange: (h: number) => void; label: string }) {
  return (
    <Field label={label}>
      <select className="input" value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {HOURS.map((h) => (
          <option key={h} value={h}>
            {String(h).padStart(2, "0")}:00
          </option>
        ))}
      </select>
    </Field>
  );
}

function RolesPicker({ value, onChange, label, hint }: { value: Role[]; onChange: (r: Role[]) => void; label: string; hint: string }) {
  return (
    <Field label={label} hint={hint}>
      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        {ROLES.map((r) => (
          <label key={r} className="row center" style={{ gap: 6 }}>
            <input
              type="checkbox"
              className="chk"
              checked={value.includes(r)}
              onChange={(e) => onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))}
            />
            {ROLE[r]}
          </label>
        ))}
      </div>
    </Field>
  );
}

/** One-line summary of what a run did, from its recorded summary. */
function runText(key: Key, run: Run): string {
  if (run.status === "failed") return run.error ?? "";
  const s = run.summary ?? {};
  if (run.status === "skipped") return "L'automatisation a été activée après l'heure prévue de cette période.";
  if (key === "overdue_reminders") {
    const students = Number(s.students ?? 0);
    if (!students) return "Aucun élève à relancer.";
    return run.mode === "propose" ? `${students} élève(s) proposé(s), ${tnd(Number(s.total))} TND` : `${Number(s.sent ?? 0)} e-mail(s) envoyé(s)`;
  }
  if (key === "payroll_month") {
    const warnings = Array.isArray(s.warnings) ? s.warnings.length : 0;
    return `${String(s.month ?? "")} : ${tnd(Number(s.total ?? 0))} TND${warnings ? `, ${warnings} point(s) à vérifier` : ""}`;
  }
  if (key === "daily_digest") return `${Number(s.sessions ?? 0)} séance(s), ${Number(s.bookings ?? 0)} réservation(s), ${Number(s.sent ?? 0)} e-mail(s)`;
  return "";
}

function AutomationCard({ automation }: { automation: Automation }) {
  const client = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>(automation.mode);
  const [params, setParams] = useState<Record<string, unknown>>(automation.params);
  const [amountText, setAmountText] = useState(tnd(Number(automation.params.minAmount ?? 0)));
  useEffect(() => {
    setMode(automation.mode);
    setParams(automation.params);
    setAmountText(tnd(Number(automation.params.minAmount ?? 0)));
  }, [automation]);
  const save = useMutation({
    mutationFn: () => api.put(`/automations/settings/${automation.key}`, { mode, params }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["automations"] });
      toast("Automatisation enregistrée.");
    },
  });
  const text = TEXT[automation.key];
  const set = (k: string, v: unknown) => setParams({ ...params, [k]: v });
  const num = (k: string) => Number(params[k]);
  const roles = (k: string) => (params[k] as Role[] | undefined) ?? [];
  const amountOk = automation.key !== "overdue_reminders" || parseTnd(amountText) !== null;
  const rolesOk = automation.key !== "daily_digest" || roles("roles").length > 0;

  return (
    <Card
      title={
        <div className="row center" style={{ gap: 8 }}>
          {text.title}
          {!automation.available ? <Badge tone="gray">Module non souscrit</Badge> : null}
        </div>
      }
      footer={
        <>
          <span className="cap">
            {automation.updatedAt ? `Modifié le ${frDateTime(automation.updatedAt)} par ${automation.updatedByName ?? "?"}` : "Jamais modifié"}
          </span>
          <button type="button" className="btn btn-p" disabled={!automation.available || !amountOk || !rolesOk || save.isPending} onClick={() => save.mutate()}>
            Enregistrer
          </button>
        </>
      }
    >
      <fieldset className="card-b stack" disabled={!automation.available} style={{ border: 0, margin: 0 }}>
        <p className="cap">{text.text}</p>
        <Segmented label={`Mode : ${text.title}`} value={mode} onChange={setMode} options={automation.modes.map((m) => ({ value: m, label: MODE_LABEL[m] }))} />
        {mode === "propose" && text.propose ? <p className="cap">{text.propose}</p> : null}
        {mode === "auto" ? <p className="cap">{text.auto}</p> : null}

        {automation.key === "overdue_reminders" ? (
          <div className="grid3">
            <Field label="Jour">
              <select className="input" value={num("weekday")} onChange={(e) => set("weekday", Number(e.target.value))}>
                {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                  <option key={d} value={d}>
                    {weekdayLabel(d)}
                  </option>
                ))}
              </select>
            </Field>
            <HourSelect label="Heure" value={num("hour")} onChange={(h) => set("hour", h)} />
            <Field label="Pas de nouvelle relance avant (jours)">
              <input
                className="input"
                type="number"
                min={1}
                max={90}
                value={num("minDaysBetween")}
                onChange={(e) => set("minDaysBetween", Math.min(90, Math.max(1, Number(e.target.value) || 1)))}
              />
            </Field>
            <Field label="Montant dû minimum (TND)" error={amountOk ? null : "Montant invalide"}>
              <input
                className="input"
                value={amountText}
                onChange={(e) => {
                  setAmountText(e.target.value);
                  const parsed = parseTnd(e.target.value);
                  if (parsed !== null) set("minAmount", parsed);
                }}
              />
            </Field>
          </div>
        ) : null}

        {automation.key === "payroll_month" ? (
          <>
            <div className="grid3">
              <Field label="Jour du mois" hint="Le mois précédent est calculé ce jour-là.">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={28}
                  value={num("day")}
                  onChange={(e) => set("day", Math.min(28, Math.max(1, Number(e.target.value) || 1)))}
                />
              </Field>
              <HourSelect label="Heure" value={num("hour")} onChange={(h) => set("hour", h)} />
            </div>
            <RolesPicker
              label="Résumé envoyé par e-mail à"
              hint="Aucun rôle coché : pas d'e-mail."
              value={roles("notifyRoles")}
              onChange={(r) => set("notifyRoles", r)}
            />
          </>
        ) : null}

        {automation.key === "daily_digest" ? (
          <>
            <div className="grid3">
              <HourSelect label="Heure d'envoi" value={num("hour")} onChange={(h) => set("hour", h)} />
            </div>
            <RolesPicker label="Envoyé à *" hint="Les comptes actifs de ces rôles." value={roles("roles")} onChange={(r) => set("roles", r)} />
          </>
        ) : null}

        {automation.runs.length ? (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Exécution</th>
                  <th>Mode</th>
                  <th>État</th>
                  <th>Résultat</th>
                </tr>
              </thead>
              <tbody>
                {automation.runs.map((r) => (
                  <tr key={r.id}>
                    <td>{frDateTime(r.startedAt)}</td>
                    <td>{MODE_LABEL[r.mode]}</td>
                    <td>
                      <Badge tone={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].label}</Badge>
                    </td>
                    <td>{runText(automation.key, r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <ErrorBanner error={save.error} />
      </fieldset>
    </Card>
  );
}

export function AutomationsPage() {
  usePage(["Paramètres", "Automatisations"]);
  const list = useQuery({ queryKey: ["automations"], queryFn: () => api.get<Automation[]>("/automations/settings") });
  return (
    <>
      <PageHeader
        title="Automatisations"
        subtitle="Chaque tâche répétitive se règle ici : désactivée, préparée puis confirmée par une personne, ou entièrement automatique. Activer une tâche ne la lance jamais tout de suite : elle part à sa prochaine échéance."
      />
      <ErrorBanner error={list.error} />
      {list.isPending ? (
        <Loading />
      ) : (
        <div className="stack">
          {list.data?.map((a) => (
            <AutomationCard key={a.key} automation={a} />
          ))}
        </div>
      )}
    </>
  );
}
