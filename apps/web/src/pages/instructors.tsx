import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api/client";
import type { GroupRow, Instructor } from "../api/types";
import { useSession } from "../auth/session";
import { usePage } from "../components/shell";
import { useToast } from "../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, PageHeader, ReasonDialog } from "../components/ui";
import { frDate, weekdayLabel } from "../lib/format";
import { EMPLOYMENT, KIND_INSTRUCTOR } from "../lib/labels";

interface InstructorDetail extends Instructor {
  notes: string | null;
  subjects: { id: string; name: string }[];
  availability: { weekday: number; startTime: string; endTime: string }[];
}
interface Subject {
  id: string;
  name: string;
  status: string;
}
interface Form {
  firstName: string;
  lastName: string;
  kind: Instructor["kind"];
  employment: Instructor["employment"];
  phone: string;
  email: string;
  notes: string;
  subjectIds: string[];
  availability: { weekday: number; startTime: string; endTime: string }[];
}

function InstructorModal({ instructor, onClose, onSaved }: { instructor: InstructorDetail | null; onClose: () => void; onSaved: (id: string) => void }) {
  const client = useQueryClient();
  const subjects = useQuery({ queryKey: ["subjects"], queryFn: () => api.get<Subject[]>("/catalogue/subjects") });
  const [v, setV] = useState<Form>(
    instructor
      ? {
          firstName: instructor.firstName,
          lastName: instructor.lastName,
          kind: instructor.kind,
          employment: instructor.employment,
          phone: instructor.phone ?? "",
          email: instructor.email ?? "",
          notes: instructor.notes ?? "",
          subjectIds: instructor.subjects.map((s) => s.id),
          availability: instructor.availability,
        }
      : { firstName: "", lastName: "", kind: "teacher", employment: "freelance", phone: "", email: "", notes: "", subjectIds: [], availability: [] },
  );
  const set = <K extends keyof Form>(k: K, value: Form[K]) => setV((o) => ({ ...o, [k]: value }));
  const save = useMutation({
    mutationFn: () => {
      const body = { ...v, firstName: v.firstName.trim(), lastName: v.lastName.trim() };
      return instructor ? api.patch<{ id: string }>(`/instructors/${instructor.id}`, body) : api.post<{ id: string }>("/instructors", body);
    },
    onSuccess: async (r) => {
      await client.invalidateQueries({ queryKey: ["instructors"] });
      await client.invalidateQueries({ queryKey: ["instructor"] });
      onSaved(r.id);
    },
  });
  const slotsValid = v.availability.every((a) => a.startTime && a.endTime && a.endTime > a.startTime);
  return (
    <Modal
      wide
      title={instructor ? "Modifier l'intervenant" : "Nouvel intervenant"}
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
              disabled={!v.firstName.trim() || !v.lastName.trim() || !slotsValid || save.isPending}
              onClick={() => save.mutate()}
            >
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <div className="grid2">
        <Field label="Prénom *">
          <input className="input" value={v.firstName} onChange={(e) => set("firstName", e.target.value)} />
        </Field>
        <Field label="Nom *">
          <input className="input" value={v.lastName} onChange={(e) => set("lastName", e.target.value)} />
        </Field>
        <Field label="Type">
          <select className="input" value={v.kind} onChange={(e) => set("kind", e.target.value as Form["kind"])}>
            {Object.entries(KIND_INSTRUCTOR).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Statut">
          <select className="input" value={v.employment} onChange={(e) => set("employment", e.target.value as Form["employment"])}>
            {Object.entries(EMPLOYMENT).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Téléphone">
          <input className="input" value={v.phone} onChange={(e) => set("phone", e.target.value)} />
        </Field>
        <Field label="E-mail">
          <input className="input" type="email" value={v.email} onChange={(e) => set("email", e.target.value)} />
        </Field>
      </div>
      <div>
        <div className="lab" style={{ marginBottom: 6 }}>
          Matières enseignées
        </div>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          {(subjects.data ?? [])
            .filter((s) => s.status === "active")
            .map((s) => (
              <label key={s.id} className="row center" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  className="chk"
                  checked={v.subjectIds.includes(s.id)}
                  onChange={(e) => set("subjectIds", e.target.checked ? [...v.subjectIds, s.id] : v.subjectIds.filter((x) => x !== s.id))}
                />
                {s.name}
              </label>
            ))}
          {subjects.data?.length === 0 ? <span className="cap">Aucune matière : créez-les depuis Cours particuliers.</span> : null}
        </div>
      </div>
      <div>
        <div className="lab" style={{ marginBottom: 6 }}>
          Disponibilités
        </div>
        <div className="stack" style={{ gap: 6 }}>
          {v.availability.map((a, i) => (
            <div key={i} className="row center" style={{ gap: 6 }}>
              <select
                className="input"
                style={{ width: 140 }}
                aria-label="Jour"
                value={a.weekday}
                onChange={(e) =>
                  set(
                    "availability",
                    v.availability.map((x, j) => (j === i ? { ...x, weekday: Number(e.target.value) } : x)),
                  )
                }
              >
                {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                  <option key={d} value={d}>
                    {weekdayLabel(d)}
                  </option>
                ))}
              </select>
              <input
                className="input"
                type="time"
                aria-label="Début"
                value={a.startTime}
                onChange={(e) =>
                  set(
                    "availability",
                    v.availability.map((x, j) => (j === i ? { ...x, startTime: e.target.value } : x)),
                  )
                }
              />
              <input
                className="input"
                type="time"
                aria-label="Fin"
                value={a.endTime}
                onChange={(e) =>
                  set(
                    "availability",
                    v.availability.map((x, j) => (j === i ? { ...x, endTime: e.target.value } : x)),
                  )
                }
              />
              <button
                type="button"
                className="btn btn-g"
                onClick={() =>
                  set(
                    "availability",
                    v.availability.filter((_, j) => j !== i),
                  )
                }
              >
                Retirer
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-g"
            style={{ alignSelf: "flex-start" }}
            onClick={() => set("availability", [...v.availability, { weekday: 1, startTime: "14:00", endTime: "18:00" }])}
          >
            + Ajouter un créneau
          </button>
          {!slotsValid ? <span className="err-text">La fin d'un créneau doit suivre son début.</span> : null}
        </div>
      </div>
      <Field label="Notes">
        <textarea className="input" value={v.notes} onChange={(e) => set("notes", e.target.value)} />
      </Field>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

export function InstructorsPage() {
  usePage(["Référentiels", "Intervenants"]);
  const { can } = useSession();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const list = useQuery({ queryKey: ["instructors"], queryFn: () => api.get<Instructor[]>("/instructors") });
  const rows = (list.data ?? []).filter((i) => showArchived || i.status === "active");
  return (
    <>
      <PageHeader
        title="Intervenants"
        actions={
          can("instructors:write") ? (
            <button type="button" className="btn btn-p" onClick={() => setCreating(true)}>
              + Nouvel intervenant
            </button>
          ) : null
        }
      />
      <Card
        title={
          <label className="row center" style={{ gap: 6 }}>
            <input type="checkbox" className="chk" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Afficher les archivés
          </label>
        }
      >
        <ErrorBanner error={list.error} retry={() => list.refetch()} />
        {list.isPending ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty title="Aucun intervenant" />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Nom</th>
                  <th>Type</th>
                  <th>Statut</th>
                  <th>Contact</th>
                  <th>Groupes actifs</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id} className="clickable" onClick={() => navigate(`/intervenants/${i.id}`)}>
                    <td>
                      <Link to={`/intervenants/${i.id}`} onClick={(e) => e.stopPropagation()}>
                        {i.lastName} {i.firstName}
                      </Link>{" "}
                      {i.status === "archived" ? <Badge tone="gray">Archivé</Badge> : null}
                    </td>
                    <td>{KIND_INSTRUCTOR[i.kind]}</td>
                    <td>{EMPLOYMENT[i.employment]}</td>
                    <td>{[i.phone, i.email].filter(Boolean).join(" · ")}</td>
                    <td>{i.activeGroups ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating ? <InstructorModal instructor={null} onClose={() => setCreating(false)} onSaved={(id) => navigate(`/intervenants/${id}`)} /> : null}
    </>
  );
}

export function InstructorPage() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const client = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const instructor = useQuery({ queryKey: ["instructor", id], queryFn: () => api.get<InstructorDetail>(`/instructors/${id}`) });
  const groups = useQuery({ queryKey: ["groups", "all"], queryFn: () => api.get<GroupRow[]>("/groups", { status: "all" }) });
  const name = instructor.data ? `${instructor.data.firstName} ${instructor.data.lastName}` : "Intervenant";
  usePage(["Référentiels", "Intervenants", name]);
  if (instructor.isPending) return <Loading />;
  if (instructor.error) return <ErrorBanner error={instructor.error} retry={() => instructor.refetch()} />;
  const i = instructor.data;
  const own = (groups.data ?? []).filter((g) => g.instructorId === id);
  return (
    <>
      <PageHeader
        title={name}
        subtitle={
          <span className="row center" style={{ gap: 8 }}>
            <Badge tone={i.status === "active" ? "green" : "gray"}>{i.status === "active" ? "Actif" : "Archivé"}</Badge>
            <span>
              {KIND_INSTRUCTOR[i.kind]} · {EMPLOYMENT[i.employment]}
            </span>
            <span>{[i.phone, i.email].filter(Boolean).join(" · ")}</span>
          </span>
        }
        actions={
          <>
            {can("payroll:read") ? (
              <>
                <Link className="btn" to={`/paie/intervenants/${id}`}>
                  Rémunération
                </Link>
                <Link className="btn btn-g" to={`/paie?onglet=regles&intervenant=${id}`}>
                  Règles de rémunération
                </Link>
              </>
            ) : null}
            {can("instructors:write") ? (
              <>
                <button type="button" className="btn" onClick={() => setEditing(true)}>
                  Modifier
                </button>
                {i.status === "active" ? (
                  <button type="button" className="btn btn-g" onClick={() => setArchiving(true)}>
                    Archiver
                  </button>
                ) : null}
              </>
            ) : null}
          </>
        }
      />
      <div className="grid2" style={{ alignItems: "start" }}>
        <Card title="Groupes">
          <ErrorBanner error={groups.error} />
          {own.length === 0 ? (
            <Empty title="Aucun groupe" />
          ) : (
            <div className="xs">
              <table className="tbl">
                <tbody>
                  {own.map((g) => (
                    <tr key={g.id}>
                      <td>
                        <Link to={`/groupes/${g.id}`}>{g.name}</Link> {g.status === "archived" ? <Badge tone="gray">Archivé</Badge> : null}
                      </td>
                      <td>
                        {frDate(g.startDate)} au {frDate(g.endDate)}
                      </td>
                      <td>
                        {g.enrolledCount}/{g.capacity}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Profil">
          <div className="card-b stack">
            <div>
              <div className="lab">Matières</div>
              <div>{i.subjects.map((s) => s.name).join(", ") || "Aucune"}</div>
            </div>
            <div>
              <div className="lab">Disponibilités</div>
              {i.availability.length ? (
                i.availability.map((a, x) => <div key={x}>{`${weekdayLabel(a.weekday)} ${a.startTime}-${a.endTime}`}</div>)
              ) : (
                <div>Non renseignées</div>
              )}
            </div>
            {i.notes ? (
              <div>
                <div className="lab">Notes</div>
                <div>{i.notes}</div>
              </div>
            ) : null}
          </div>
        </Card>
      </div>
      {editing ? (
        <InstructorModal
          instructor={i}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            toast("Intervenant mis à jour.");
          }}
        />
      ) : null}
      {archiving ? (
        <ReasonDialog
          title="Archiver l'intervenant"
          explanation="Ses groupes actifs doivent d'abord être archivés ou réaffectés. Son historique et sa paie restent consultables."
          confirmLabel="Archiver"
          onClose={() => setArchiving(false)}
          onConfirm={async (reason) => {
            await api.post(`/instructors/${id}/archive`, { reason });
            await client.invalidateQueries();
            toast("Intervenant archivé.");
          }}
        />
      ) : null}
    </>
  );
}
