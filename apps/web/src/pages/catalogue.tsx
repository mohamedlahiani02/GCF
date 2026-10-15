import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api/client";
import type { PlanItem, Study, TrainingDetail } from "../api/types";
import { useSession } from "../auth/session";
import { usePage } from "../components/shell";
import { useToast } from "../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, PageHeader, ReasonDialog, Segmented } from "../components/ui";
import { frDate, percent, tnd, tryParseTnd } from "../lib/format";

interface Subject {
  id: string;
  name: string;
  status: string;
}
interface TrainingRow {
  id: string;
  title: string;
  category: string | null;
  durationHours: number;
  price: number;
  capacity: number;
  paymentModes: "full" | "installments" | "both";
  status: string;
  openSessions: number;
}

const PAYMENT_MODES: Record<TrainingRow["paymentModes"], string> = { full: "Paiement intégral", installments: "Par tranches", both: "Intégral ou tranches" };

/* Private studies */

interface StudyForm {
  subjectId: string;
  name: string;
  billingMode: "monthly" | "per_session";
  price: string;
  absenceBilled: boolean;
  sessionsPerWeek: string;
  capacity: string;
}

function SubjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (s: Subject) => void }) {
  const [name, setName] = useState("");
  const client = useQueryClient();
  const create = useMutation({
    mutationFn: () => api.post<Subject>("/catalogue/subjects", { name: name.trim() }),
    onSuccess: async (s) => {
      await client.invalidateQueries({ queryKey: ["subjects"] });
      onCreated(s);
    },
  });
  return (
    <Modal
      title="Nouvelle matière"
      onClose={onClose}
      footer={
        <>
          <span />
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
              Créer
            </button>
          </div>
        </>
      }
    >
      <Field label="Nom de la matière *">
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <ErrorBanner error={create.error} />
    </Modal>
  );
}

function StudyModal({ study, subjects, onClose }: { study: Study | null; subjects: Subject[]; onClose: () => void }) {
  const toast = useToast();
  const client = useQueryClient();
  const [addingSubject, setAddingSubject] = useState(false);
  const [v, setV] = useState<StudyForm>(
    study
      ? {
          subjectId: study.subjectId,
          name: study.name,
          billingMode: study.billingMode,
          price: tnd(study.price),
          absenceBilled: study.absenceBilled,
          sessionsPerWeek: String(study.sessionsPerWeek),
          capacity: String(study.capacity),
        }
      : { subjectId: "", name: "", billingMode: "monthly", price: "", absenceBilled: true, sessionsPerWeek: "2", capacity: "12" },
  );
  const set = <K extends keyof StudyForm>(k: K, value: StudyForm[K]) => setV((o) => ({ ...o, [k]: value }));
  const price = tryParseTnd(v.price);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        subjectId: v.subjectId,
        name: v.name.trim(),
        billingMode: v.billingMode,
        price,
        absenceBilled: v.absenceBilled,
        sessionsPerWeek: Number(v.sessionsPerWeek),
        capacity: Number(v.capacity),
      };
      return study ? api.patch(`/catalogue/studies/${study.id}`, body) : api.post("/catalogue/studies", body);
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["studies"] });
      toast(study ? "Étude mise à jour." : "Étude créée.");
      onClose();
    },
  });
  const valid = v.subjectId && v.name.trim() && price !== null && price >= 0 && Number(v.sessionsPerWeek) >= 1 && Number(v.capacity) >= 1;
  return (
    <Modal
      wide
      title={study ? "Modifier l'étude" : "Nouvelle étude privée"}
      onClose={onClose}
      footer={
        <>
          <span className="cap">Le mode de facturation ne change plus une fois des élèves inscrits</span>
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
        <Field label="Matière *">
          <div className="input-with-action">
            <select className="input" value={v.subjectId} onChange={(e) => set("subjectId", e.target.value)}>
              <option value="">Choisir</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button type="button" className="btn" onClick={() => setAddingSubject(true)} aria-label="Nouvelle matière">
              +
            </button>
          </div>
        </Field>
        <Field label="Nom *">
          <input className="input" value={v.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
      </div>
      <div>
        <div className="lab" style={{ marginBottom: 6 }}>
          Facturation
        </div>
        <Segmented
          label="Facturation"
          value={v.billingMode}
          onChange={(m) => set("billingMode", m)}
          options={[
            { value: "monthly", label: "Mensuelle" },
            { value: "per_session", label: "À la séance" },
          ]}
        />
      </div>
      <div className="grid3">
        <Field
          label={v.billingMode === "monthly" ? "Prix mensuel (TND) *" : "Prix par séance (TND) *"}
          error={v.price && price === null ? "Montant invalide" : null}
        >
          <input className="input num" inputMode="decimal" value={v.price} onChange={(e) => set("price", e.target.value)} />
        </Field>
        <Field label="Séances par semaine *">
          <input className="input num" type="number" min={1} max={14} value={v.sessionsPerWeek} onChange={(e) => set("sessionsPerWeek", e.target.value)} />
        </Field>
        <Field label="Capacité par groupe *">
          <input className="input num" type="number" min={1} value={v.capacity} onChange={(e) => set("capacity", e.target.value)} />
        </Field>
      </div>
      <label className="row center" style={{ gap: 8 }}>
        <input type="checkbox" className="chk" checked={v.absenceBilled} onChange={(e) => set("absenceBilled", e.target.checked)} />
        {v.billingMode === "per_session" ? "Facturer la séance même en cas d'absence" : "Absences facturées (le mois reste dû)"}
      </label>
      <ErrorBanner error={save.error} />
      {addingSubject ? (
        <SubjectModal
          onClose={() => setAddingSubject(false)}
          onCreated={(s) => {
            set("subjectId", s.id);
            setAddingSubject(false);
          }}
        />
      ) : null}
    </Modal>
  );
}

export function StudiesPage() {
  usePage(["Études privées"]);
  const { can } = useSession();
  const navigate = useNavigate();
  const client = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Study | "new" | null>(null);
  const [archiving, setArchiving] = useState<Study | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const studies = useQuery({ queryKey: ["studies"], queryFn: () => api.get<Study[]>("/catalogue/studies") });
  const subjects = useQuery({ queryKey: ["subjects"], queryFn: () => api.get<Subject[]>("/catalogue/subjects") });
  const subjectName = (id: string) => subjects.data?.find((s) => s.id === id)?.name ?? "";
  const rows = (studies.data ?? []).filter((s) => showArchived || s.status === "active");
  return (
    <>
      <PageHeader
        title="Études privées"
        actions={
          can("catalogue:write") ? (
            <button type="button" className="btn btn-p" onClick={() => setEditing("new")}>
              + Nouvelle étude
            </button>
          ) : null
        }
      />
      <Card
        title={
          <label className="row center" style={{ gap: 6 }}>
            <input type="checkbox" className="chk" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Afficher les études archivées
          </label>
        }
      >
        <ErrorBanner error={studies.error ?? subjects.error} retry={() => studies.refetch()} />
        {studies.isPending ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty title="Aucune étude" text="Créez une étude privée (matière, niveau, tarif) puis ses groupes." />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Étude</th>
                  <th>Matière</th>
                  <th>Facturation</th>
                  <th className="num">Prix (TND)</th>
                  <th>Absences</th>
                  <th>Groupes</th>
                  <th>Élèves</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {s.name} {s.status === "archived" ? <Badge tone="gray">Archivée</Badge> : null}
                    </td>
                    <td>{subjectName(s.subjectId)}</td>
                    <td>{s.billingMode === "monthly" ? "Mensuelle" : "À la séance"}</td>
                    <td className="num">{tnd(s.price)}</td>
                    <td>{s.absenceBilled ? "Facturées" : "Non facturées"}</td>
                    <td>{s.groupCount}</td>
                    <td>{s.studentCount}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {can("groups:write") && s.status === "active" ? (
                        <button type="button" className="btn btn-g" onClick={() => navigate(`/groupes/nouveau?etude=${s.id}`)}>
                          + Groupe
                        </button>
                      ) : null}
                      <Link className="btn btn-g" to={`/groupes?etude=${s.id}`}>
                        Groupes
                      </Link>
                      {can("catalogue:write") && s.status === "active" ? (
                        <>
                          <button type="button" className="btn btn-g" onClick={() => setEditing(s)}>
                            Modifier
                          </button>
                          <button type="button" className="btn btn-g" onClick={() => setArchiving(s)}>
                            Archiver
                          </button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing ? (
        <StudyModal
          study={editing === "new" ? null : editing}
          subjects={(subjects.data ?? []).filter((s) => s.status === "active")}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {archiving ? (
        <ReasonDialog
          title="Archiver l'étude"
          explanation={`${archiving.name} : l'étude n'accepte plus de nouveaux groupes. Ses groupes doivent être archivés avant.`}
          confirmLabel="Archiver"
          onClose={() => setArchiving(null)}
          onConfirm={async (reason) => {
            await api.post(`/catalogue/studies/${archiving.id}/archive`, { reason });
            await client.invalidateQueries({ queryKey: ["studies"] });
            toast("Étude archivée.");
          }}
        />
      ) : null}
    </>
  );
}

/* Trainings */

interface TrainingForm {
  title: string;
  category: string;
  description: string;
  durationHours: string;
  price: string;
  capacity: string;
  paymentModes: TrainingRow["paymentModes"];
}

function TrainingModal({ training, onClose, onSaved }: { training: TrainingDetail | null; onClose: () => void; onSaved: (id: string) => void }) {
  const client = useQueryClient();
  const [v, setV] = useState<TrainingForm>(
    training
      ? {
          title: training.title,
          category: training.category ?? "",
          description: training.description ?? "",
          durationHours: String(training.durationHours),
          price: tnd(training.price),
          capacity: String(training.capacity),
          paymentModes: training.paymentModes,
        }
      : { title: "", category: "", description: "", durationHours: "", price: "", capacity: "15", paymentModes: "both" },
  );
  const set = <K extends keyof TrainingForm>(k: K, value: TrainingForm[K]) => setV((o) => ({ ...o, [k]: value }));
  const price = tryParseTnd(v.price);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        title: v.title.trim(),
        category: v.category.trim(),
        description: v.description.trim(),
        durationHours: Number(v.durationHours),
        price,
        capacity: Number(v.capacity),
        paymentModes: v.paymentModes,
      };
      return training ? api.patch<{ id: string }>(`/catalogue/trainings/${training.id}`, body) : api.post<{ id: string }>("/catalogue/trainings", body);
    },
    onSuccess: async (r) => {
      await client.invalidateQueries({ queryKey: ["trainings"] });
      await client.invalidateQueries({ queryKey: ["training"] });
      onSaved(r.id);
    },
  });
  const valid = v.title.trim() && Number(v.durationHours) >= 1 && price !== null && price >= 0 && Number(v.capacity) >= 1;
  return (
    <Modal
      wide
      title={training ? "Modifier la formation" : "Nouvelle formation"}
      onClose={onClose}
      footer={
        <>
          <span />
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
        <Field label="Intitulé *">
          <input className="input" value={v.title} onChange={(e) => set("title", e.target.value)} />
        </Field>
        <Field label="Catégorie">
          <input className="input" value={v.category} onChange={(e) => set("category", e.target.value)} />
        </Field>
      </div>
      <div className="grid3">
        <Field label="Durée (heures) *">
          <input className="input num" type="number" min={1} value={v.durationHours} onChange={(e) => set("durationHours", e.target.value)} />
        </Field>
        <Field label="Prix total (TND) *" error={v.price && price === null ? "Montant invalide" : null}>
          <input className="input num" inputMode="decimal" value={v.price} onChange={(e) => set("price", e.target.value)} />
        </Field>
        <Field label="Capacité *">
          <input className="input num" type="number" min={1} value={v.capacity} onChange={(e) => set("capacity", e.target.value)} />
        </Field>
      </div>
      <div>
        <div className="lab" style={{ marginBottom: 6 }}>
          Modes de paiement autorisés
        </div>
        <Segmented
          label="Modes de paiement"
          value={v.paymentModes}
          onChange={(m) => set("paymentModes", m)}
          options={(["full", "installments", "both"] as const).map((m) => ({ value: m, label: PAYMENT_MODES[m] }))}
        />
      </div>
      <Field label="Description">
        <textarea className="input" value={v.description} onChange={(e) => set("description", e.target.value)} />
      </Field>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

export function TrainingsPage() {
  usePage(["Formations"]);
  const { can } = useSession();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const trainings = useQuery({ queryKey: ["trainings"], queryFn: () => api.get<TrainingRow[]>("/catalogue/trainings") });
  return (
    <>
      <PageHeader
        title="Formations"
        actions={
          can("catalogue:write") ? (
            <button type="button" className="btn btn-p" onClick={() => setCreating(true)}>
              + Nouvelle formation
            </button>
          ) : null
        }
      />
      <Card>
        <ErrorBanner error={trainings.error} retry={() => trainings.refetch()} />
        {trainings.isPending ? (
          <Loading />
        ) : trainings.data?.length === 0 ? (
          <Empty title="Aucune formation" />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Formation</th>
                  <th>Durée</th>
                  <th className="num">Prix (TND)</th>
                  <th>Paiement</th>
                  <th>Sessions ouvertes</th>
                </tr>
              </thead>
              <tbody>
                {trainings.data?.map((t) => (
                  <tr key={t.id} className="clickable" onClick={() => navigate(`/formations/${t.id}`)}>
                    <td>
                      <Link to={`/formations/${t.id}`} onClick={(e) => e.stopPropagation()}>
                        {t.title}
                      </Link>
                      {t.category ? <div className="cap">{t.category}</div> : null}
                    </td>
                    <td>{t.durationHours} h</td>
                    <td className="num">{tnd(t.price)}</td>
                    <td>{PAYMENT_MODES[t.paymentModes]}</td>
                    <td>{t.openSessions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating ? <TrainingModal training={null} onClose={() => setCreating(false)} onSaved={(id) => navigate(`/formations/${id}`)} /> : null}
    </>
  );
}

/* Payment plan editor */

interface ItemDraft {
  label: string;
  valueKind: "percent" | "amount";
  value: string;
  dueKind: "relative" | "fixed";
  dueOffsetDays: string;
  dueDate: string;
}

const toDraft = (i: PlanItem): ItemDraft => ({
  label: i.label,
  valueKind: i.valueKind,
  value: i.valueKind === "percent" ? String(i.value / 100).replace(".", ",") : tnd(i.value),
  dueKind: i.dueKind,
  dueOffsetDays: i.dueOffsetDays === null ? "" : String(i.dueOffsetDays),
  dueDate: i.dueDate ?? "",
});

function draftValue(d: ItemDraft): number | null {
  if (d.valueKind === "amount") return tryParseTnd(d.value);
  const n = Number(d.value.replace(",", "."));
  return Number.isFinite(n) && n > 0 && n <= 100 && Number.isInteger(Math.round(n * 100)) ? Math.round(n * 100) : null;
}

function toItems(drafts: ItemDraft[]) {
  const items = drafts.map((d) => {
    const value = draftValue(d);
    if (value === null || !d.label.trim()) return null;
    if (d.dueKind === "relative") {
      const days = Number(d.dueOffsetDays);
      if (d.dueOffsetDays === "" || !Number.isInteger(days) || days < 0) return null;
      return { label: d.label.trim(), valueKind: d.valueKind, value, dueKind: d.dueKind, dueOffsetDays: days };
    }
    if (!d.dueDate) return null;
    return { label: d.label.trim(), valueKind: d.valueKind, value, dueKind: d.dueKind, dueDate: d.dueDate };
  });
  return items.every((i) => i !== null) ? items : null;
}

function PlanEditor({ training, plan, onClose }: { training: TrainingDetail; plan: TrainingDetail["plans"][number] | null; onClose: () => void }) {
  const toast = useToast();
  const client = useQueryClient();
  const [name, setName] = useState(plan?.name ?? "");
  const [isDefault, setIsDefault] = useState(plan?.isDefault ?? training.plans.length === 0);
  const [drafts, setDrafts] = useState<ItemDraft[]>(
    plan
      ? plan.items.map(toDraft)
      : [
          { label: "Inscription", valueKind: "percent", value: "50", dueKind: "relative", dueOffsetDays: "0", dueDate: "" },
          { label: "Solde", valueKind: "percent", value: "50", dueKind: "relative", dueOffsetDays: "30", dueDate: "" },
        ],
  );
  const items = toItems(drafts);
  const [debounced, setDebounced] = useState(items);
  const key = JSON.stringify(items);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(JSON.parse(key) as typeof items), 250);
    return () => window.clearTimeout(t);
  }, [key]);
  const preview = useQuery({
    queryKey: ["plan-preview", training.id, debounced],
    queryFn: () =>
      api.post<{ valid: boolean; price: number; amounts?: number[]; total?: number; message?: string }>(`/catalogue/trainings/${training.id}/plans/preview`, {
        items: debounced,
      }),
    enabled: !!debounced && debounced.length > 0,
  });
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), isDefault, items };
      return plan ? api.put(`/catalogue/plans/${plan.id}`, body) : api.post(`/catalogue/trainings/${training.id}/plans`, body);
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["training", training.id] });
      toast(plan ? "Plan mis à jour. Les échéanciers déjà créés ne changent pas." : "Plan créé.");
      onClose();
    },
  });
  const update = (index: number, patch: Partial<ItemDraft>) => setDrafts((list) => list.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  const valid = !!items && name.trim() && preview.data?.valid;
  return (
    <Modal
      wide
      title={plan ? `Modifier le plan « ${plan.name} »` : "Nouveau plan de tranches"}
      onClose={onClose}
      footer={
        <>
          <span className="cap">Prix de la formation : {tnd(training.price)} TND</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
              Enregistrer le plan
            </button>
          </div>
        </>
      }
    >
      <div className="grid2">
        <Field label="Nom du plan *">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <label className="row center" style={{ gap: 8, alignSelf: "end" }}>
          <input type="checkbox" className="chk" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /> Plan proposé par défaut
        </label>
      </div>
      <div className="card xs">
        <table className="tbl">
          <thead>
            <tr>
              <th>Tranche</th>
              <th>Valeur</th>
              <th>Échéance</th>
              <th className="num">Montant (TND)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {drafts.map((d, i) => (
              <tr key={i}>
                <td>
                  <input
                    className="input"
                    aria-label={`Libellé de la tranche ${i + 1}`}
                    value={d.label}
                    onChange={(e) => update(i, { label: e.target.value })}
                  />
                </td>
                <td>
                  <div className="row" style={{ gap: 6 }}>
                    <select
                      className="input"
                      style={{ width: 70 }}
                      aria-label="Type de valeur"
                      value={d.valueKind}
                      onChange={(e) => update(i, { valueKind: e.target.value as ItemDraft["valueKind"] })}
                    >
                      <option value="percent">%</option>
                      <option value="amount">TND</option>
                    </select>
                    <input
                      className={`input num${draftValue(d) === null ? " err" : ""}`}
                      style={{ width: 100 }}
                      aria-label="Valeur"
                      inputMode="decimal"
                      value={d.value}
                      onChange={(e) => update(i, { value: e.target.value })}
                    />
                  </div>
                </td>
                <td>
                  <div className="row" style={{ gap: 6 }}>
                    <select
                      className="input"
                      style={{ width: 150 }}
                      aria-label="Type d'échéance"
                      value={d.dueKind}
                      onChange={(e) => update(i, { dueKind: e.target.value as ItemDraft["dueKind"] })}
                    >
                      <option value="relative">Jours après l'inscription</option>
                      <option value="fixed">Date fixe</option>
                    </select>
                    {d.dueKind === "relative" ? (
                      <input
                        className="input num"
                        style={{ width: 80 }}
                        type="number"
                        min={0}
                        aria-label="Nombre de jours"
                        value={d.dueOffsetDays}
                        onChange={(e) => update(i, { dueOffsetDays: e.target.value })}
                      />
                    ) : (
                      <input
                        className="input"
                        type="date"
                        aria-label="Date d'échéance"
                        value={d.dueDate}
                        onChange={(e) => update(i, { dueDate: e.target.value })}
                      />
                    )}
                  </div>
                </td>
                <td className="num">{preview.data?.valid && preview.data.amounts ? tnd(preview.data.amounts[i]) : ""}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn-g"
                    aria-label={`Supprimer la tranche ${i + 1}`}
                    disabled={drafts.length === 1}
                    onClick={() => setDrafts((list) => list.filter((_, x) => x !== i))}
                  >
                    Supprimer
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>
                <button
                  type="button"
                  className="btn btn-g"
                  onClick={() =>
                    setDrafts((list) => [
                      ...list,
                      { label: `Tranche ${list.length + 1}`, valueKind: "percent", value: "", dueKind: "relative", dueOffsetDays: "", dueDate: "" },
                    ])
                  }
                >
                  + Ajouter une tranche
                </button>
              </td>
              <td className="num">{preview.data?.valid ? tnd(preview.data.total) : ""}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      {preview.data && !preview.data.valid ? (
        <div className="ban ban-red" role="alert">
          <span>Le total des tranches doit être égal au prix de la formation ({tnd(training.price)} TND).</span>
        </div>
      ) : preview.data?.valid ? (
        <div className="ban ban-green">
          <span>Total conforme au prix de la formation.</span>
        </div>
      ) : null}
      <ErrorBanner error={save.error ?? preview.error} />
    </Modal>
  );
}

function SessionModal({ trainingId, session, onClose }: { trainingId: string; session: TrainingDetail["sessions"][number] | null; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(session?.name ?? "");
  const [startDate, setStartDate] = useState(session?.startDate ?? "");
  const [endDate, setEndDate] = useState(session?.endDate ?? "");
  const [status, setStatus] = useState<"open" | "closed">((session?.status as "open" | "closed") ?? "open");
  const save = useMutation({
    mutationFn: () =>
      session
        ? api.patch(`/catalogue/training-sessions/${session.id}`, { name: name.trim(), startDate, endDate, status })
        : api.post(`/catalogue/trainings/${trainingId}/sessions`, { name: name.trim(), startDate, endDate }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["training", trainingId] });
      toast(session ? "Session mise à jour." : "Session créée.");
      onClose();
    },
  });
  return (
    <Modal
      title={session ? "Modifier la session" : "Nouvelle session"}
      onClose={onClose}
      footer={
        <>
          <span />
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-p"
              disabled={!name.trim() || !startDate || !endDate || endDate < startDate || save.isPending}
              onClick={() => save.mutate()}
            >
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <Field label="Nom de la session *" hint="Par exemple : Session de novembre 2026">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="grid2">
        <Field label="Début *">
          <input className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </Field>
        <Field label="Fin *" error={endDate && startDate && endDate < startDate ? "La fin précède le début." : null}>
          <input className="input" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </Field>
      </div>
      {session ? (
        <Segmented
          label="Statut"
          value={status}
          onChange={setStatus}
          options={[
            { value: "open", label: "Ouverte aux inscriptions" },
            { value: "closed", label: "Fermée" },
          ]}
        />
      ) : null}
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

export function TrainingPage() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const client = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [plan, setPlan] = useState<TrainingDetail["plans"][number] | "new" | null>(null);
  const [archivingPlan, setArchivingPlan] = useState<TrainingDetail["plans"][number] | null>(null);
  const [session, setSession] = useState<TrainingDetail["sessions"][number] | "new" | null>(null);
  const training = useQuery({ queryKey: ["training", id], queryFn: () => api.get<TrainingDetail>(`/catalogue/trainings/${id}`) });
  usePage(["Formations", training.data?.title ?? "Formation"]);
  if (training.isPending) return <Loading />;
  if (training.error) return <ErrorBanner error={training.error} retry={() => training.refetch()} />;
  const t = training.data;
  const plans = t.plans.filter((p) => p.status === "active");
  return (
    <>
      <PageHeader
        title={t.title}
        subtitle={`${t.category ? `${t.category} · ` : ""}${t.durationHours} h · ${tnd(t.price)} TND · ${PAYMENT_MODES[t.paymentModes]} · ${t.capacity} places`}
        actions={
          can("catalogue:write") ? (
            <button type="button" className="btn" onClick={() => setEditing(true)}>
              Modifier
            </button>
          ) : null
        }
      />
      {t.description ? (
        <Card>
          <div className="card-b">{t.description}</div>
        </Card>
      ) : null}
      <div className="grid2" style={{ alignItems: "start" }}>
        <Card
          title="Plans de tranches"
          actions={
            can("catalogue:write") && t.paymentModes !== "full" ? (
              <button type="button" className="btn" onClick={() => setPlan("new")}>
                + Nouveau plan
              </button>
            ) : null
          }
        >
          {t.paymentModes === "full" ? (
            <div className="card-b cap">Cette formation se paie intégralement : aucun plan de tranches.</div>
          ) : plans.length === 0 ? (
            <Empty title="Aucun plan" text="Un plan est nécessaire pour inscrire par tranches." />
          ) : (
            <div className="xs">
              <table className="tbl">
                <tbody>
                  {plans.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <strong>{p.name}</strong> {p.isDefault ? <Badge tone="blue">Par défaut</Badge> : null}
                        <div className="cap">
                          {p.items
                            .map(
                              (item, i) =>
                                `${item.label} : ${tnd(p.amounts[i])} TND (${item.valueKind === "percent" ? percent(item.value) : "montant"}), ${item.dueKind === "relative" ? `J+${item.dueOffsetDays}` : `le ${frDate(item.dueDate)}`}`,
                            )
                            .join(" · ")}
                        </div>
                      </td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        {can("catalogue:write") ? (
                          <>
                            <button type="button" className="btn btn-g" onClick={() => setPlan(p)}>
                              Modifier
                            </button>
                            <button type="button" className="btn btn-g" onClick={() => setArchivingPlan(p)}>
                              Archiver
                            </button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card
          title="Sessions"
          actions={
            can("catalogue:write") ? (
              <button type="button" className="btn" onClick={() => setSession("new")}>
                + Nouvelle session
              </button>
            ) : null
          }
        >
          {t.sessions.length === 0 ? (
            <Empty title="Aucune session" text="Une session regroupe les groupes d'une même période." />
          ) : (
            <div className="xs">
              <table className="tbl">
                <tbody>
                  {t.sessions.map((s) => (
                    <tr key={s.id}>
                      <td>
                        {s.name}
                        <div className="cap">
                          {frDate(s.startDate)} au {frDate(s.endDate)}
                        </div>
                      </td>
                      <td>{s.status === "open" ? <Badge tone="green">Ouverte</Badge> : <Badge tone="gray">Fermée</Badge>}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        {can("groups:write") && s.status === "open" ? (
                          <button type="button" className="btn btn-g" onClick={() => navigate(`/groupes/nouveau?session=${s.id}&formation=${t.id}`)}>
                            + Groupe
                          </button>
                        ) : null}
                        <Link className="btn btn-g" to={`/groupes?session=${s.id}`}>
                          Groupes
                        </Link>
                        {can("catalogue:write") ? (
                          <button type="button" className="btn btn-g" onClick={() => setSession(s)}>
                            Modifier
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
      </div>
      {editing ? (
        <TrainingModal
          training={t}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            toast("Formation mise à jour.");
          }}
        />
      ) : null}
      {plan ? <PlanEditor training={t} plan={plan === "new" ? null : plan} onClose={() => setPlan(null)} /> : null}
      {session ? <SessionModal trainingId={t.id} session={session === "new" ? null : session} onClose={() => setSession(null)} /> : null}
      {archivingPlan ? (
        <ReasonDialog
          title="Archiver le plan"
          explanation={`${archivingPlan.name} ne sera plus proposé aux nouvelles inscriptions. Les échéanciers existants ne changent pas.`}
          confirmLabel="Archiver"
          onClose={() => setArchivingPlan(null)}
          onConfirm={async (reason) => {
            await api.post(`/catalogue/plans/${archivingPlan.id}/archive`, { reason });
            await client.invalidateQueries({ queryKey: ["training", t.id] });
            toast("Plan archivé.");
          }}
        />
      ) : null}
    </>
  );
}
