import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../api/client";
import type { GroupDetail, GroupRow, GroupSession, Instructor, Room, Slot, Study, TrainingDetail } from "../api/types";
import { useSession } from "../auth/session";
import { usePage } from "../components/shell";
import { useToast } from "../components/toasts";
import {
  AttendanceBadge,
  Badge,
  Bar,
  Card,
  ConflictBanner,
  Empty,
  ErrorBanner,
  Field,
  Kpi,
  Loading,
  Modal,
  PageHeader,
  ReasonDialog,
  Segmented,
  Tabs,
  rateTone,
} from "../components/ui";
import { conflictsOf } from "../lib/errors";
import { addDaysIso, frDate, frDateTime, frTime, localParts, monthLabel, percent, tnd, todayIso, tryParseTnd, weekdayLabel, zonedIso } from "../lib/format";
import { PAY_BASE, SHEET } from "../lib/labels";

interface TrainingRow {
  id: string;
  title: string;
  status: string;
}
export interface PlanningItem {
  type: "course" | "training" | "rental";
  id: string;
  startsAt: string;
  endsAt: string;
  status?: string;
  sheetStatus?: "none" | "in_progress" | "validated";
  groupId?: string;
  groupName?: string;
  instructorId?: string;
  instructorName?: string;
  rentalId?: string;
  renterName?: string;
  roomId: string | null;
  roomName: string | null;
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

/* Weekly slots editor shared by creation and the planning tab */

function SlotsEditor({ slots, rooms, onChange }: { slots: Slot[]; rooms: Room[]; onChange: (slots: Slot[]) => void }) {
  const update = (i: number, patch: Partial<Slot>) => onChange(slots.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div className="stack" style={{ gap: 6 }}>
      {slots.map((s, i) => (
        <div key={i} className="row center" style={{ gap: 6, flexWrap: "wrap" }}>
          <select className="input" style={{ width: 130 }} aria-label="Jour" value={s.weekday} onChange={(e) => update(i, { weekday: Number(e.target.value) })}>
            {WEEKDAYS.map((d) => (
              <option key={d} value={d}>
                {weekdayLabel(d)}
              </option>
            ))}
          </select>
          <input
            className="input"
            style={{ width: 110 }}
            type="time"
            aria-label="Début"
            value={s.startTime}
            onChange={(e) => update(i, { startTime: e.target.value })}
          />
          <input
            className="input"
            style={{ width: 110 }}
            type="time"
            aria-label="Fin"
            value={s.endTime}
            onChange={(e) => update(i, { endTime: e.target.value })}
          />
          <select
            className="input"
            style={{ width: 170 }}
            aria-label="Salle du créneau"
            value={s.roomId ?? ""}
            onChange={(e) => update(i, { roomId: e.target.value || null })}
          >
            <option value="">Salle du groupe</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-g" onClick={() => onChange(slots.filter((_, j) => j !== i))}>
            Retirer
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-g"
        style={{ alignSelf: "flex-start" }}
        onClick={() => onChange([...slots, { weekday: 1, startTime: "17:00", endTime: "18:30", roomId: null }])}
      >
        + Ajouter un créneau
      </button>
      {slots.some((s) => !s.startTime || !s.endTime || s.endTime <= s.startTime) ? (
        <span className="err-text">La fin d'un créneau doit suivre son début.</span>
      ) : null}
    </div>
  );
}

const slotsValid = (slots: Slot[]) => slots.every((s) => s.startTime && s.endTime && s.endTime > s.startTime);
const slotPayload = (slots: Slot[]) => slots.map((s) => ({ weekday: s.weekday, startTime: s.startTime, endTime: s.endTime, roomId: s.roomId }));

/* List */

type Category = "cours" | "formations";
type TrainingGrouping = "formation" | "formateur";

const slotsText = (slots: Slot[]) => slots.map((s) => `${weekdayLabel(s.weekday).slice(0, 3)}. ${s.startTime}-${s.endTime}`).join(", ");

/** One group with the shortcuts the secretariat uses every day. */
function GroupLine({ g, showInstructor, showOffer }: { g: GroupRow; showInstructor: boolean; showOffer: boolean }) {
  const { can } = useSession();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const attendanceTarget = g.attendanceSessionId ?? g.nextSessionId;
  return (
    <tr>
      <td>
        <Link to={`/groupes/${g.id}`}>
          <strong>{g.name}</strong>
        </Link>{" "}
        {g.status === "archived" ? <Badge tone="gray">Archivé</Badge> : null}
        <div className="cap">
          {[
            showOffer ? (g.kind === "study" ? g.studyName : `${g.trainingTitle} · ${g.trainingSessionName}`) : null,
            showInstructor ? `${g.instructorFirstName} ${g.instructorLastName}` : null,
            g.roomName,
            slotsText(g.slots),
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </td>
      <td style={{ minWidth: 120 }}>
        <div className="row center" style={{ gap: 8 }}>
          <Bar value={(g.enrolledCount / g.capacity) * 100} tone={g.enrolledCount >= g.capacity ? "r" : undefined} />
          <span className="num">
            {g.enrolledCount}/{g.capacity}
          </span>
        </div>
      </td>
      <td>
        {g.nextSessionAt ? (
          <>
            {frDate(g.nextSessionAt)} {frTime(g.nextSessionAt)}
          </>
        ) : (
          <span className="cap">Aucune séance prévue</span>
        )}
        {g.attendanceSessionId ? (
          <div>
            <Badge tone="amber">Présences à saisir</Badge>
          </div>
        ) : null}
      </td>
      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
        <Link className="btn btn-g" to={`/groupes/${g.id}?onglet=eleves`}>
          Élèves
        </Link>
        <Link className="btn btn-g" to={`/groupes/${g.id}?onglet=seances`}>
          Séances
        </Link>
        {can("groups:write") && g.status === "active" ? (
          <button type="button" className="btn btn-g" onClick={() => setAdding(true)}>
            + Séance
          </button>
        ) : null}
        {can("attendance:write") ? (
          <button
            type="button"
            className="btn btn-g"
            disabled={!attendanceTarget}
            title={attendanceTarget ? undefined : "Aucune séance à saisir"}
            onClick={() => navigate(`/presences/${attendanceTarget}`)}
          >
            Saisir les présences
          </button>
        ) : null}
        {adding ? <AddSessionModal group={g} onClose={() => setAdding(false)} /> : null}
      </td>
    </tr>
  );
}

function GroupTable({ groups, showInstructor, showOffer }: { groups: GroupRow[]; showInstructor: boolean; showOffer: boolean }) {
  return (
    <div className="xs">
      <table className="tbl">
        <thead>
          <tr>
            <th>Groupe</th>
            <th>Élèves</th>
            <th>Prochaine séance</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <GroupLine key={g.id} g={g} showInstructor={showInstructor} showOffer={showOffer} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Gestion des groupes: private lessons grouped by teacher, trainings grouped by training or by trainer. Every group
 * gives its students, its sessions, a new session and the attendance to enter in one click.
 */
export function GroupsPage() {
  usePage(["Gestion des groupes"]);
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const studyId = params.get("cours");
  const sessionId = params.get("session");
  const category: Category = params.get("categorie") === "formations" || sessionId ? "formations" : "cours";
  const grouping: TrainingGrouping = params.get("par") === "formateur" ? "formateur" : "formation";
  const [status, setStatus] = useState<"active" | "archived" | "all">("active");
  const update = (patch: Record<string, string>) => setParams({ categorie: category, par: grouping, ...patch });
  const groups = useQuery({
    queryKey: ["groups", "management", studyId, sessionId, status],
    queryFn: () => api.get<GroupRow[]>("/groups", { studyId, trainingSessionId: sessionId, status }),
  });
  const list = (groups.data ?? []).filter((g) => (category === "cours" ? g.kind === "study" : g.kind === "training"));
  const sections = new Map<string, { title: string; sub: string; groups: GroupRow[] }>();
  for (const g of list) {
    const byInstructor = category === "cours" || grouping === "formateur";
    const key = byInstructor ? g.instructorId : (g.trainingId ?? "");
    const section = sections.get(key) ?? {
      title: byInstructor ? `${g.instructorLastName} ${g.instructorFirstName}` : (g.trainingTitle ?? ""),
      sub: "",
      groups: [],
    };
    section.groups.push(g);
    sections.set(key, section);
  }
  for (const section of sections.values()) {
    section.sub = `${section.groups.length} groupe(s) · ${section.groups.reduce((s, g) => s + g.enrolledCount, 0)} élève(s)`;
  }
  const sorted = [...sections.values()].sort((a, b) => a.title.localeCompare(b.title, "fr"));
  const newGroupLink = `/groupes/nouveau?type=${category === "cours" ? "cours" : "formation"}${studyId ? `&cours=${studyId}` : ""}`;
  return (
    <>
      <PageHeader
        title="Gestion des groupes"
        subtitle={studyId || sessionId ? <Link to="/groupes">Voir tous les groupes</Link> : undefined}
        actions={
          can("groups:write") ? (
            <Link className="btn btn-p btn-l" to={newGroupLink}>
              + Créer un groupe
            </Link>
          ) : null
        }
      />
      <div className="row between center" style={{ flexWrap: "wrap", gap: 12 }}>
        <Segmented
          label="Catégorie"
          value={category}
          onChange={(c) => setParams({ categorie: c, par: grouping })}
          options={[
            { value: "cours", label: "Cours particuliers" },
            { value: "formations", label: "Formations" },
          ]}
        />
        <div className="row center" style={{ gap: 8 }}>
          {category === "formations" ? (
            <>
              <span className="lab">Regrouper par</span>
              <Segmented
                label="Regrouper par"
                value={grouping}
                onChange={(p) => update({ par: p })}
                options={[
                  { value: "formation", label: "Formation" },
                  { value: "formateur", label: "Formateur" },
                ]}
              />
            </>
          ) : (
            <span className="cap">Groupes regroupés par enseignant</span>
          )}
          <select className="input" style={{ width: 140 }} aria-label="Statut" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="active">Actifs</option>
            <option value="archived">Archivés</option>
            <option value="all">Tous</option>
          </select>
        </div>
      </div>
      <ErrorBanner error={groups.error} retry={() => groups.refetch()} />
      {groups.isPending ? (
        <Loading />
      ) : sorted.length === 0 ? (
        <Card>
          <Empty
            title={category === "cours" ? "Aucun groupe de cours particulier" : "Aucun groupe de formation"}
            text="Un groupe réunit des élèves autour d'un intervenant, avec ses propres séances."
            action={
              can("groups:write") ? (
                <Link className="btn btn-p" to={newGroupLink}>
                  + Créer un groupe
                </Link>
              ) : undefined
            }
          />
        </Card>
      ) : (
        sorted.map((section) => (
          <Card key={section.title} title={section.title} actions={<span className="cap">{section.sub}</span>}>
            <GroupTable
              groups={section.groups}
              showInstructor={category === "formations" && grouping === "formation"}
              showOffer={category === "cours" || grouping === "formateur"}
            />
          </Card>
        ))
      )}
    </>
  );
}

/** "Ajouter une séance", prefilled with the group's next weekly slot, instructor and room; all three can be changed. */
export function AddSessionModal({ group, onClose }: { group: Pick<GroupRow, "id" | "name" | "instructorId" | "roomId" | "slots">; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const instructors = useQuery({ queryKey: ["instructors"], queryFn: () => api.get<Instructor[]>("/instructors") });
  const rooms = useQuery({ queryKey: ["rooms"], queryFn: () => api.get<Room[]>("/catalogue/rooms") });
  const today = todayIso();
  const next = (() => {
    for (let i = 0; i < 7; i += 1) {
      const date = addDaysIso(today, i);
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
      const slot = group.slots.find((s) => s.weekday === weekday);
      if (slot) return { date, startTime: slot.startTime, endTime: slot.endTime, roomId: slot.roomId ?? group.roomId };
    }
    return { date: today, startTime: "17:00", endTime: "18:30", roomId: group.roomId };
  })();
  const [date, setDate] = useState(next.date);
  const [startTime, setStartTime] = useState(next.startTime);
  const [endTime, setEndTime] = useState(next.endTime);
  const [instructorId, setInstructorId] = useState(group.instructorId);
  const [roomId, setRoomId] = useState(next.roomId ?? "");
  const add = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/groups/${group.id}/sessions`, { date, startTime, endTime, roomId: roomId || null, instructorId }),
    onSuccess: async () => {
      await client.invalidateQueries();
      toast(`Séance ajoutée le ${frDate(date)} à ${startTime}.`);
      onClose();
    },
  });
  const conflicts = conflictsOf(add.error);
  return (
    <Modal
      wide
      title={`Ajouter une séance : ${group.name}`}
      onClose={onClose}
      footer={
        <>
          <span className="cap">Les conflits de salle et d'intervenant sont vérifiés à l'enregistrement</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!date || endTime <= startTime || add.isPending} onClick={() => add.mutate()}>
              Ajouter la séance
            </button>
          </div>
        </>
      }
    >
      <div className="grid3">
        <Field label="Date">
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Début">
          <input className="input" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        </Field>
        <Field label="Fin" error={endTime <= startTime ? "La fin doit suivre le début." : null}>
          <input className="input" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </Field>
      </div>
      <div className="grid2">
        <Field label="Intervenant">
          <select className="input" value={instructorId} onChange={(e) => setInstructorId(e.target.value)}>
            {(instructors.data ?? [])
              .filter((i) => i.status === "active" || i.id === group.instructorId)
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.lastName} {i.firstName}
                  {i.id === group.instructorId ? " (intervenant du groupe)" : ""}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Salle">
          <select className="input" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            <option value="">Salle par défaut du groupe</option>
            {(rooms.data ?? [])
              .filter((r) => r.status === "active")
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
          </select>
        </Field>
      </div>
      <ConflictBanner conflicts={conflicts} />
      {conflicts.length === 0 ? <ErrorBanner error={add.error} /> : null}
    </Modal>
  );
}

/* Creation */

export function GroupCreatePage() {
  usePage(["Gestion des groupes", "Nouveau groupe"]);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [kind, setKind] = useState<"study" | "training">(params.get("session") || params.get("type") === "formation" ? "training" : "study");
  const [studyId, setStudyId] = useState(params.get("cours") ?? "");
  const [trainingId, setTrainingId] = useState(params.get("formation") ?? "");
  const [trainingSessionId, setTrainingSessionId] = useState(params.get("session") ?? "");
  const [name, setName] = useState("");
  const [instructorId, setInstructorId] = useState("");
  const [roomId, setRoomId] = useState("");
  const [capacity, setCapacity] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [priceText, setPriceText] = useState("");
  const [slots, setSlots] = useState<Slot[]>([{ weekday: 2, startTime: "17:00", endTime: "18:30", roomId: null }]);

  const studies = useQuery({ queryKey: ["studies"], queryFn: () => api.get<Study[]>("/catalogue/studies") });
  const trainings = useQuery({ queryKey: ["trainings"], queryFn: () => api.get<TrainingRow[]>("/catalogue/trainings") });
  const training = useQuery({
    queryKey: ["training", trainingId],
    queryFn: () => api.get<TrainingDetail>(`/catalogue/trainings/${trainingId}`),
    enabled: !!trainingId,
  });
  const instructors = useQuery({ queryKey: ["instructors"], queryFn: () => api.get<Instructor[]>("/instructors") });
  const rooms = useQuery({ queryKey: ["rooms"], queryFn: () => api.get<Room[]>("/catalogue/rooms") });
  const activeRooms = (rooms.data ?? []).filter((r) => r.status === "active");
  const study = studies.data?.find((s) => s.id === studyId);
  const trainingSession = training.data?.sessions.find((s) => s.id === trainingSessionId);

  useEffect(() => {
    if (trainingSession) {
      setStartDate((d) => d || trainingSession.startDate);
      setEndDate((d) => d || trainingSession.endDate);
    }
  }, [trainingSession]);

  const priceOverride = priceText.trim() ? tryParseTnd(priceText) : null;
  const ready = !!instructorId && !!startDate && !!endDate && endDate >= startDate && slotsValid(slots);
  const checkBody = ready ? { instructorId, roomId: roomId || null, startDate, endDate, slots: slotPayload(slots) } : null;
  const [debounced, setDebounced] = useState(checkBody);
  const checkKey = JSON.stringify(checkBody);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(JSON.parse(checkKey) as typeof checkBody), 300);
    return () => window.clearTimeout(t);
  }, [checkKey]);
  const check = useQuery({
    queryKey: ["check-slots", debounced],
    queryFn: () =>
      api.post<{ conflicts: { type: "room" | "instructor"; groupName: string; weekday: number; startTime: string; endTime: string }[] }>(
        "/groups/check-slots",
        debounced,
      ),
    enabled: !!debounced,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<GroupDetail>("/groups", {
        kind,
        ...(kind === "study" ? { studyId } : { trainingSessionId }),
        name: name.trim(),
        instructorId,
        roomId: roomId || null,
        ...(capacity ? { capacity: Number(capacity) } : {}),
        startDate,
        endDate,
        priceOverride: priceText.trim() ? priceOverride : null,
        slots: slotPayload(slots),
      }),
    onSuccess: (g) => {
      toast("Groupe créé. Générez maintenant ses séances depuis l'onglet Planning.");
      navigate(`/groupes/${g.id}`);
    },
  });
  const conflicts = check.data?.conflicts ?? [];
  const offerOk = kind === "study" ? !!studyId : !!trainingSessionId;
  const canCreate = offerOk && name.trim() && ready && conflicts.length === 0 && (!priceText.trim() || priceOverride !== null) && !create.isPending;

  return (
    <>
      <PageHeader title="Nouveau groupe" />
      <div className="grid2" style={{ gridTemplateColumns: "2fr 1fr", alignItems: "start" }}>
        <Card
          title="Définition du groupe"
          footer={
            <>
              <span className="cap">Les conflits de salle et d'intervenant sont vérifiés en direct</span>
              <button type="button" className="btn btn-p" disabled={!canCreate} onClick={() => create.mutate()}>
                Créer le groupe
              </button>
            </>
          }
        >
          <div className="card-b stack">
            <Segmented
              label="Type de groupe"
              value={kind}
              onChange={setKind}
              options={[
                { value: "study", label: "Cours particulier" },
                { value: "training", label: "Formation" },
              ]}
            />
            {kind === "study" ? (
              <Field label="Cours particulier *">
                <select className="input" value={studyId} onChange={(e) => setStudyId(e.target.value)}>
                  <option value="">Choisir un cours particulier</option>
                  {(studies.data ?? [])
                    .filter((s) => s.status === "active")
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} · {tnd(s.price)} TND {s.billingMode === "monthly" ? "/ mois" : "/ séance"}
                      </option>
                    ))}
                </select>
              </Field>
            ) : (
              <div className="grid2">
                <Field label="Formation *">
                  <select className="input" value={trainingId} onChange={(e) => (setTrainingId(e.target.value), setTrainingSessionId(""))}>
                    <option value="">Choisir une formation</option>
                    {(trainings.data ?? [])
                      .filter((t) => t.status === "active")
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.title}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="Session *">
                  <select className="input" value={trainingSessionId} onChange={(e) => setTrainingSessionId(e.target.value)} disabled={!training.data}>
                    <option value="">Choisir une session</option>
                    {(training.data?.sessions ?? [])
                      .filter((s) => s.status === "open")
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({frDate(s.startDate)} au {frDate(s.endDate)})
                        </option>
                      ))}
                  </select>
                </Field>
              </div>
            )}
            <div className="grid2">
              <Field label="Nom du groupe *">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Intervenant *">
                <select className="input" value={instructorId} onChange={(e) => setInstructorId(e.target.value)}>
                  <option value="">Choisir</option>
                  {(instructors.data ?? [])
                    .filter((i) => i.status === "active")
                    .map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.lastName} {i.firstName}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Salle par défaut">
                <select className="input" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
                  <option value="">Aucune</option>
                  {activeRooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.capacity} places)
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Capacité" hint={study ? `Par défaut : ${study.capacity}` : training.data ? `Par défaut : ${training.data.capacity}` : undefined}>
                <input className="input num" type="number" min={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
              </Field>
              <Field label="Début *">
                <input className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </Field>
              <Field label="Fin *" error={startDate && endDate && endDate < startDate ? "La fin précède le début." : null}>
                <input className="input" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </Field>
              <Field
                label="Tarif spécifique (TND)"
                hint="Laisser vide pour appliquer le tarif de l'offre."
                error={priceText.trim() && priceOverride === null ? "Montant invalide" : null}
              >
                <input className="input num" inputMode="decimal" value={priceText} onChange={(e) => setPriceText(e.target.value)} />
              </Field>
            </div>
            <div>
              <div className="lab" style={{ marginBottom: 6 }}>
                Créneaux hebdomadaires
              </div>
              <SlotsEditor slots={slots} rooms={activeRooms} onChange={setSlots} />
            </div>
            <ConflictBanner conflicts={conflicts} />
            <ErrorBanner error={create.error ?? check.error} />
          </div>
        </Card>
        <Card title="Contrôle du planning">
          <div className="card-b stack">
            {!ready ? (
              <span className="cap">Renseignez l'intervenant, les dates et les créneaux pour vérifier les conflits.</span>
            ) : check.isFetching ? (
              <span className="cap">Vérification…</span>
            ) : conflicts.length ? (
              <Badge tone="red">{conflicts.length} conflit(s)</Badge>
            ) : (
              <Badge tone="green">Aucun conflit</Badge>
            )}
            {slots.map((s, i) => (
              <div key={i}>
                {weekdayLabel(s.weekday)} {s.startTime}-{s.endTime}
                <span className="cap"> · {activeRooms.find((r) => r.id === (s.roomId ?? roomId))?.name ?? "sans salle"}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}

/* Detail */

type Tab = "students" | "planning" | "attendance" | "finance" | "pay";
const TAB_PARAM: Record<string, Tab> = { eleves: "students", seances: "planning", presences: "attendance", finances: "finance", remuneration: "pay" };
const PARAM_OF: Record<Tab, string> = { students: "eleves", planning: "seances", attendance: "presences", finance: "finances", pay: "remuneration" };

/**
 * The group's next sessions with the three daily actions: see every session, add one (prefilled with the group,
 * its instructor and room) and enter attendance (the oldest started session still to fill, else the next one).
 */
function NextSessions({ group, onSeeAll }: { group: GroupDetail; onSeeAll: () => void }) {
  const { can } = useSession();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const today = todayIso();
  const sessions = useQuery({
    queryKey: ["group-sessions", group.id, addDaysIso(today, -30), addDaysIso(today, 60)],
    queryFn: () => api.get<GroupSession[]>(`/groups/${group.id}/sessions`, { from: addDaysIso(today, -30), to: addDaysIso(today, 60) }),
  });
  const now = Date.now();
  const list = sessions.data ?? [];
  const pending = list.find((s) => s.status !== "cancelled" && s.sheetStatus !== "validated" && new Date(s.startsAt).getTime() <= now);
  const upcoming = list.filter((s) => s.status === "scheduled" && new Date(s.startsAt).getTime() > now).slice(0, 3);
  const attendanceTarget = pending ?? upcoming[0];
  return (
    <Card
      title="Prochaines séances"
      actions={
        <>
          <button type="button" className="btn btn-g" onClick={onSeeAll}>
            Voir toutes les séances
          </button>
          {can("groups:write") && group.status === "active" ? (
            <button type="button" className="btn" onClick={() => setAdding(true)}>
              + Ajouter une séance
            </button>
          ) : null}
          {can("attendance:write") ? (
            <button
              type="button"
              className="btn btn-p"
              disabled={!attendanceTarget}
              onClick={() => attendanceTarget && navigate(`/presences/${attendanceTarget.id}`)}
            >
              Saisir les présences
            </button>
          ) : null}
        </>
      }
    >
      <ErrorBanner error={sessions.error} />
      {pending ? (
        <div className="card-b">
          <div className="ban ban-amber">
            <span>
              Présences à saisir pour la séance du {frDate(pending.startsAt)} à {frTime(pending.startsAt)}.
            </span>
          </div>
        </div>
      ) : null}
      {sessions.isPending ? (
        <Loading />
      ) : upcoming.length === 0 ? (
        <div className="card-b cap">Aucune séance prévue. Générez les séances depuis l'onglet Séances, ou ajoutez une séance.</div>
      ) : (
        <div className="xs">
          <table className="tbl">
            <tbody>
              {upcoming.map((s) => (
                <tr key={s.id}>
                  <td>
                    {weekdayLabel(new Date(`${localParts(s.startsAt).date}T00:00:00Z`).getUTCDay() || 7)} {frDate(s.startsAt)}
                  </td>
                  <td>
                    {frTime(s.startsAt)}-{frTime(s.endsAt)}
                  </td>
                  <td>{s.roomName ?? "Sans salle"}</td>
                  <td>{s.instructorName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding ? (
        <AddSessionModal
          group={{ id: group.id, name: group.name, instructorId: group.instructorId, roomId: group.roomId, slots: group.slots }}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </Card>
  );
}

function EditGroupModal({ group, onClose }: { group: GroupDetail; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const instructors = useQuery({ queryKey: ["instructors"], queryFn: () => api.get<Instructor[]>("/instructors") });
  const rooms = useQuery({ queryKey: ["rooms"], queryFn: () => api.get<Room[]>("/catalogue/rooms") });
  const [name, setName] = useState(group.name);
  const [instructorId, setInstructorId] = useState(group.instructorId);
  const [roomId, setRoomId] = useState(group.roomId ?? "");
  const [capacity, setCapacity] = useState(String(group.capacity));
  const [startDate, setStartDate] = useState(group.startDate);
  const [endDate, setEndDate] = useState(group.endDate);
  const [priceText, setPriceText] = useState(group.priceOverride === null ? "" : tnd(group.priceOverride));
  const priceOverride = priceText.trim() ? tryParseTnd(priceText) : null;
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/groups/${group.id}`, {
        name: name.trim(),
        instructorId,
        roomId: roomId || null,
        capacity: Number(capacity),
        startDate,
        endDate,
        priceOverride,
      }),
    onSuccess: async () => {
      await client.invalidateQueries();
      toast("Groupe mis à jour. Les séances déjà planifiées gardent leur intervenant et leur salle.");
      onClose();
    },
  });
  return (
    <Modal
      wide
      title="Modifier le groupe"
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
              disabled={!name.trim() || Number(capacity) < 1 || endDate < startDate || (priceText.trim() !== "" && priceOverride === null) || save.isPending}
              onClick={() => save.mutate()}
            >
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <div className="grid2">
        <Field label="Nom">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Intervenant">
          <select className="input" value={instructorId} onChange={(e) => setInstructorId(e.target.value)}>
            {(instructors.data ?? [])
              .filter((i) => i.status === "active" || i.id === group.instructorId)
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.lastName} {i.firstName}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Salle par défaut">
          <select className="input" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            <option value="">Aucune</option>
            {(rooms.data ?? [])
              .filter((r) => r.status === "active")
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Capacité">
          <input className="input num" type="number" min={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
        </Field>
        <Field label="Début">
          <input className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </Field>
        <Field label="Fin">
          <input className="input" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </Field>
        <Field label="Tarif spécifique (TND)" hint="Vide : tarif de l'offre. S'applique aux nouvelles échéances.">
          <input className="input num" inputMode="decimal" value={priceText} onChange={(e) => setPriceText(e.target.value)} />
        </Field>
      </div>
      <ErrorBanner error={save.error} />
      <ConflictBanner conflicts={conflictsOf(save.error)} />
    </Modal>
  );
}

export function MoveSessionModal({ item, groupInstructorId, onClose }: { item: PlanningItem; groupInstructorId: string; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const rooms = useQuery({ queryKey: ["rooms"], queryFn: () => api.get<Room[]>("/catalogue/rooms") });
  const instructors = useQuery({ queryKey: ["instructors"], queryFn: () => api.get<Instructor[]>("/instructors") });
  const start = localParts(item.startsAt);
  const end = localParts(item.endsAt);
  const [date, setDate] = useState(start.date);
  const [startTime, setStartTime] = useState(start.time);
  const [endTime, setEndTime] = useState(end.time);
  const [roomId, setRoomId] = useState(item.roomId ?? "");
  const [instructorId, setInstructorId] = useState("");
  const move = useMutation({
    mutationFn: () =>
      api.patch(`/sessions/${item.id}/move`, {
        startsAt: zonedIso(date, startTime),
        endsAt: zonedIso(date, endTime),
        roomId: roomId || null,
        ...(instructorId ? { instructorId } : {}),
      }),
    onSuccess: async () => {
      await client.invalidateQueries();
      toast("Séance déplacée.");
      onClose();
    },
  });
  return (
    <Modal
      wide
      title="Déplacer la séance"
      onClose={onClose}
      footer={
        <>
          <span className="cap">Initialement le {frDateTime(item.startsAt)}</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!date || endTime <= startTime || move.isPending} onClick={() => move.mutate()}>
              Déplacer
            </button>
          </div>
        </>
      }
    >
      <div className="grid3">
        <Field label="Date">
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Début">
          <input className="input" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        </Field>
        <Field label="Fin">
          <input className="input" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </Field>
      </div>
      <div className="grid2">
        <Field label="Salle">
          <select className="input" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            <option value="">Aucune</option>
            {(rooms.data ?? [])
              .filter((r) => r.status === "active")
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Remplaçant (facultatif)">
          <select className="input" value={instructorId} onChange={(e) => setInstructorId(e.target.value)}>
            <option value="">Intervenant actuel</option>
            {(instructors.data ?? [])
              .filter((i) => i.status === "active" && i.id !== groupInstructorId)
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.lastName} {i.firstName}
                </option>
              ))}
          </select>
        </Field>
      </div>
      <ConflictBanner conflicts={conflictsOf(move.error)} />
      {conflictsOf(move.error).length === 0 ? <ErrorBanner error={move.error} /> : null}
    </Modal>
  );
}

function PlanningTab({ group }: { group: GroupDetail }) {
  const { can } = useSession();
  const client = useQueryClient();
  const toast = useToast();
  const today = todayIso();
  const rooms = useQuery({ queryKey: ["rooms"], queryFn: () => api.get<Room[]>("/catalogue/rooms") });
  const [from, setFrom] = useState(today > group.startDate ? today : group.startDate);
  const [to, setTo] = useState(group.endDate);
  const [editingSlots, setEditingSlots] = useState<Slot[] | null>(null);
  const [moving, setMoving] = useState<PlanningItem | null>(null);
  const [cancelling, setCancelling] = useState<PlanningItem | null>(null);
  const [adding, setAdding] = useState(false);
  const [windowFrom, setWindowFrom] = useState(today);
  const windowTo = addDaysIso(windowFrom, 27);
  const planning = useQuery({
    queryKey: ["group-sessions", group.id, windowFrom, windowTo],
    queryFn: () => api.get<GroupSession[]>(`/groups/${group.id}/sessions`, { from: windowFrom, to: windowTo }),
  });
  const sessions: (PlanningItem & { status: GroupSession["status"] })[] = (planning.data ?? []).map((s) => ({
    ...s,
    type: group.kind === "study" ? ("course" as const) : ("training" as const),
    groupId: group.id,
    groupName: group.name,
  }));
  const generate = useMutation({
    mutationFn: (skipConflicts: boolean) =>
      api.post<{ created: number; skippedExisting: number; conflicts: unknown[] }>(`/groups/${group.id}/sessions/generate`, { from, to, skipConflicts }),
    onSuccess: async (r) => {
      await client.invalidateQueries();
      toast(
        `${r.created} séance(s) créée(s)${r.skippedExisting ? `, ${r.skippedExisting} déjà existante(s)` : ""}${r.conflicts.length ? `, ${r.conflicts.length} écartée(s) pour conflit` : ""}.`,
      );
    },
  });
  const saveSlots = useMutation({
    mutationFn: (slots: Slot[]) => api.put(`/groups/${group.id}/slots`, { slots: slotPayload(slots) }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["group", group.id] });
      toast("Créneaux enregistrés. Les séances déjà générées ne changent pas.");
      setEditingSlots(null);
    },
  });
  const generateConflicts = conflictsOf(generate.error);
  const activeRooms = (rooms.data ?? []).filter((r) => r.status === "active");
  return (
    <div className="stack">
      <div className="grid2" style={{ alignItems: "start" }}>
        <Card
          title="Créneaux hebdomadaires"
          actions={
            can("groups:write") && !editingSlots ? (
              <button type="button" className="btn" onClick={() => setEditingSlots(group.slots)}>
                Modifier
              </button>
            ) : null
          }
        >
          <div className="card-b stack">
            {editingSlots ? (
              <>
                <SlotsEditor slots={editingSlots} rooms={activeRooms} onChange={setEditingSlots} />
                <ConflictBanner conflicts={conflictsOf(saveSlots.error)} />
                {conflictsOf(saveSlots.error).length === 0 ? <ErrorBanner error={saveSlots.error} /> : null}
                <div className="row" style={{ gap: 8 }}>
                  <button type="button" className="btn" onClick={() => setEditingSlots(null)}>
                    Annuler
                  </button>
                  <button
                    type="button"
                    className="btn btn-p"
                    disabled={!slotsValid(editingSlots) || saveSlots.isPending}
                    onClick={() => saveSlots.mutate(editingSlots)}
                  >
                    Enregistrer
                  </button>
                </div>
              </>
            ) : group.slots.length ? (
              group.slots.map((s) => (
                <div key={s.id ?? `${s.weekday}${s.startTime}`}>
                  {weekdayLabel(s.weekday)} {s.startTime}-{s.endTime}
                  <span className="cap"> · {activeRooms.find((r) => r.id === (s.roomId ?? group.roomId))?.name ?? "sans salle"}</span>
                </div>
              ))
            ) : (
              <span className="cap">Aucun créneau.</span>
            )}
          </div>
        </Card>
        {can("groups:write") ? (
          <Card title="Générer les séances">
            <div className="card-b stack">
              <div className="grid2">
                <Field label="Du">
                  <input className="input" type="date" value={from} min={group.startDate} max={group.endDate} onChange={(e) => setFrom(e.target.value)} />
                </Field>
                <Field label="Au">
                  <input className="input" type="date" value={to} min={group.startDate} max={group.endDate} onChange={(e) => setTo(e.target.value)} />
                </Field>
              </div>
              <span className="cap">
                Les séances existantes sont conservées. Un créneau en conflit bloque la génération, sauf si vous choisissez de l'écarter.
              </span>
              <ConflictBanner conflicts={generateConflicts} />
              {generateConflicts.length === 0 ? <ErrorBanner error={generate.error} /> : null}
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn btn-p" disabled={!from || !to || to < from || generate.isPending} onClick={() => generate.mutate(false)}>
                  Générer
                </button>
                {generateConflicts.length ? (
                  <button type="button" className="btn" disabled={generate.isPending} onClick={() => generate.mutate(true)}>
                    Générer en écartant les conflits
                  </button>
                ) : null}
                <button type="button" className="btn btn-g" onClick={() => setAdding(true)}>
                  + Ajouter une séance
                </button>
              </div>
            </div>
          </Card>
        ) : null}
      </div>
      <Card
        title={`Séances du ${frDate(windowFrom)} au ${frDate(windowTo)}`}
        actions={
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn btn-g" aria-label="Période précédente" onClick={() => setWindowFrom(addDaysIso(windowFrom, -28))}>
              ‹
            </button>
            <button type="button" className="btn btn-g" onClick={() => setWindowFrom(today)}>
              Aujourd'hui
            </button>
            <button type="button" className="btn btn-g" aria-label="Période suivante" onClick={() => setWindowFrom(addDaysIso(windowFrom, 28))}>
              ›
            </button>
          </div>
        }
      >
        <ErrorBanner error={planning.error} />
        {sessions.length === 0 ? (
          <Empty title="Aucune séance sur la période" />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Horaire</th>
                  <th>Salle</th>
                  <th>Intervenant</th>
                  <th>Feuille</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {weekdayLabel(new Date(`${localParts(s.startsAt).date}T00:00:00Z`).getUTCDay() || 7)} {frDate(s.startsAt)}
                    </td>
                    <td>
                      {frTime(s.startsAt)}-{frTime(s.endsAt)}
                    </td>
                    <td>{s.roomName ?? ""}</td>
                    <td>{s.instructorName}</td>
                    <td>
                      {s.status === "cancelled" ? (
                        <Badge tone="gray" strike>
                          Annulée
                        </Badge>
                      ) : (
                        <Badge tone={SHEET[s.sheetStatus ?? "none"]!.tone}>{SHEET[s.sheetStatus ?? "none"]!.label}</Badge>
                      )}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {s.status !== "cancelled" ? (
                        <Link className="btn btn-g" to={`/presences/${s.id}`}>
                          {s.sheetStatus === "validated" ? "Feuille" : "Saisir les présences"}
                        </Link>
                      ) : null}
                      {can("groups:write") && s.status === "scheduled" && s.sheetStatus !== "validated" ? (
                        <>
                          <button type="button" className="btn btn-g" onClick={() => setMoving(s)}>
                            Déplacer
                          </button>
                          <button type="button" className="btn btn-g" onClick={() => setCancelling(s)}>
                            Annuler
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
      {moving ? <MoveSessionModal item={moving} groupInstructorId={group.instructorId} onClose={() => setMoving(null)} /> : null}
      {cancelling ? (
        <ReasonDialog
          title="Annuler la séance"
          danger
          explanation={`Séance du ${frDateTime(cancelling.startsAt)}. Une séance annulée n'est ni due ni payée à l'intervenant, et n'est pas facturée.`}
          confirmLabel="Annuler la séance"
          onClose={() => setCancelling(null)}
          onConfirm={async (reason) => {
            await api.post(`/sessions/${cancelling.id}/cancel`, { reason });
            await client.invalidateQueries();
            toast("Séance annulée.");
          }}
        />
      ) : null}
      {adding ? (
        <AddSessionModal
          group={{ id: group.id, name: group.name, instructorId: group.instructorId, roomId: group.roomId, slots: group.slots }}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </div>
  );
}

function MonthPicker({ value, onChange }: { value: string; onChange: (m: string) => void }) {
  return (
    <input className="input" type="month" aria-label="Mois" style={{ width: 170 }} value={value} onChange={(e) => e.target.value && onChange(e.target.value)} />
  );
}

function monthEnd(month: string): string {
  const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  return addDaysIso(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`, -1);
}

function AttendanceTab({ group }: { group: GroupDetail }) {
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const data = useQuery({
    queryKey: ["group-attendance", group.id, month],
    queryFn: () =>
      api.get<{
        sessions: { id: string; localDate: string }[];
        rows: { studentId: string; firstName: string; lastName: string; cells: Record<string, string>; rateBasisPoints: number | null }[];
        groupRateBasisPoints: number | null;
      }>(`/groups/${group.id}/attendance`, { from: `${month}-01`, to: monthEnd(month) }),
  });
  return (
    <Card
      title={
        <div className="row center" style={{ gap: 10 }}>
          <MonthPicker value={month} onChange={setMonth} />
          {data.data?.groupRateBasisPoints !== null && data.data?.groupRateBasisPoints !== undefined ? (
            <span>
              Taux du groupe : <strong>{percent(data.data.groupRateBasisPoints)}</strong>
            </span>
          ) : null}
        </div>
      }
      actions={<span className="cap">Feuilles validées uniquement · P présent, A absent, J justifié, R rattrapage</span>}
    >
      <ErrorBanner error={data.error} />
      {data.isPending ? (
        <Loading />
      ) : !data.data || data.data.sessions.length === 0 ? (
        <Empty title="Aucune feuille validée ce mois-ci" />
      ) : (
        <div className="xs">
          <table className="tbl">
            <thead>
              <tr>
                <th>Élève</th>
                {data.data.sessions.map((s) => (
                  <th key={s.id} style={{ textAlign: "center" }}>
                    {s.localDate.slice(8, 10)}/{s.localDate.slice(5, 7)}
                  </th>
                ))}
                <th>Taux</th>
              </tr>
            </thead>
            <tbody>
              {data.data.rows.map((r) => (
                <tr key={r.studentId}>
                  <td>
                    <Link to={`/eleves/${r.studentId}`}>
                      {r.lastName} {r.firstName}
                    </Link>
                  </td>
                  {data.data.sessions.map((s) => (
                    <td key={s.id} style={{ textAlign: "center" }}>
                      {r.cells[s.id] ? <AttendanceBadge status={r.cells[s.id]!} short /> : <span className="cap">-</span>}
                    </td>
                  ))}
                  <td style={{ minWidth: 130 }}>
                    {r.rateBasisPoints !== null ? (
                      <div className="row center" style={{ gap: 6 }}>
                        <Bar value={r.rateBasisPoints / 100} tone={rateTone(r.rateBasisPoints)} />
                        <span className="num">{percent(r.rateBasisPoints)}</span>
                      </div>
                    ) : (
                      "-"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function FinanceTab({ group }: { group: GroupDetail }) {
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const finance = useQuery({
    queryKey: ["group-finance", group.id, month],
    queryFn: () => api.get<{ invoiced: number; collected: number; unpaid: number; postponed: number }>(`/groups/${group.id}/finance`, { month }),
  });
  const f = finance.data;
  return (
    <Card title={<MonthPicker value={month} onChange={setMonth} />}>
      <div className="card-b stack">
        <ErrorBanner error={finance.error} />
        {f ? (
          <div className="grid4">
            <Kpi label="Facturé" value={<span className="num">{tnd(f.invoiced)}</span>} sub={`TND, échéances de ${monthLabel(month)} (remises déduites)`} />
            <Kpi label="Encaissé" value={<span className="num">{tnd(f.collected)}</span>} sub="TND, paiements reçus ce mois" />
            <Kpi
              label="Impayé"
              value={<span className="num">{tnd(f.unpaid)}</span>}
              sub="TND restant sur les échéances du mois"
              tone={f.unpaid > 0 ? "amber" : undefined}
            />
            <Kpi label="Reporté" value={<span className="num">{tnd(f.postponed)}</span>} sub="TND sur des échéances reportées" />
          </div>
        ) : (
          <Loading />
        )}
      </div>
    </Card>
  );
}

function PayTab({ group }: { group: GroupDetail }) {
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const estimate = useQuery({
    queryKey: ["pay-estimate", group.id, month],
    queryFn: () =>
      api.get<{
        lines: {
          instructorId: string;
          label: string;
          periodicity: "session" | "month" | "training";
          rule: { base_kind: string };
          base: number;
          rate: { numerator: number; denominator: number };
          amount: number;
          dueOn: string;
          details: { sessions?: number; rateBasisPoints?: number | null };
        }[];
        warnings: { code: string }[];
      }>("/payroll/estimate", { groupId: group.id, month }),
  });
  const lines = estimate.data?.lines ?? [];
  return (
    <Card
      title={<MonthPicker value={month} onChange={setMonth} />}
      actions={
        <>
          <span className="cap">Estimation sur les séances tenues et validées, sans rien enregistrer</span>
          <Link className="btn" to={`/paie/intervenants/${group.instructorId}?mois=${month}`}>
            Paie de l'intervenant
          </Link>
        </>
      }
    >
      <ErrorBanner error={estimate.error} />
      {estimate.data?.warnings.some((w) => w.code === "no_rule") ? (
        <div className="card-b">
          <div className="ban ban-amber">
            <span>Aucune règle de rémunération ne s'applique à ce groupe.</span>
          </div>
        </div>
      ) : null}
      {estimate.isPending ? (
        <Loading />
      ) : lines.length === 0 ? (
        <Empty title="Rien à estimer ce mois-ci" />
      ) : (
        <div className="xs">
          <table className="tbl">
            <thead>
              <tr>
                <th>Élément</th>
                <th>Base</th>
                <th>Présence</th>
                <th className="num">Montant (TND)</th>
                <th>Échéance</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    {l.label}
                    <div className="cap">{l.details.sessions ?? 0} séance(s)</div>
                  </td>
                  <td>
                    {tnd(l.base)}
                    <div className="cap">{PAY_BASE[l.rule.base_kind] ?? l.rule.base_kind}</div>
                  </td>
                  <td>
                    × {percent(Math.round((l.rate.numerator * 10000) / l.rate.denominator))}
                    <div className="cap">taux élèves {percent(l.details.rateBasisPoints ?? null)}</div>
                  </td>
                  <td className="num">{tnd(l.amount)}</td>
                  <td>{frDate(l.dueOn)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>Total estimé</td>
                <td className="num">{tnd(lines.reduce((s, l) => s + l.amount, 0))}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  );
}

export function GroupPage() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const client = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab: Tab = TAB_PARAM[params.get("onglet") ?? ""] ?? "students";
  const setTab = (t: Tab) => setParams({ onglet: PARAM_OF[t] }, { replace: true });
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const group = useQuery({ queryKey: ["group", id], queryFn: () => api.get<GroupDetail>(`/groups/${id}`) });
  usePage(["Gestion des groupes", group.data?.name ?? "Groupe"]);
  if (group.isPending) return <Loading />;
  if (group.error) return <ErrorBanner error={group.error} retry={() => group.refetch()} />;
  const g = group.data;
  const offer = g.kind === "study" ? g.studyName : `${g.trainingTitle} · ${g.trainingSessionName}`;
  const tabs: { value: Tab; label: string }[] = [
    { value: "students", label: `Élèves (${g.enrolledCount})` },
    { value: "planning", label: "Séances et planning" },
    { value: "attendance", label: "Présences" },
    ...(can("payments:read") ? [{ value: "finance" as const, label: "Finances" }] : []),
    ...(can("payroll:read") ? [{ value: "pay" as const, label: "Rémunération" }] : []),
  ];
  return (
    <>
      <PageHeader
        title={g.name}
        subtitle={
          <span className="row center" style={{ gap: 8, flexWrap: "wrap" }}>
            <Badge tone={g.status === "active" ? "green" : "gray"}>{g.status === "active" ? "Actif" : "Archivé"}</Badge>
            <span>{offer}</span>
            <span>
              · <Link to={`/intervenants/${g.instructorId}`}>{`${g.instructorFirstName} ${g.instructorLastName}`}</Link>
            </span>
            <span>· {g.roomName ?? "sans salle"}</span>
            <span>
              · {frDate(g.startDate)} au {frDate(g.endDate)}
            </span>
            <span>
              · {tnd(g.effective.price)} TND{g.kind === "study" ? (g.billingMode === "monthly" ? " / mois" : " / séance") : ""}
            </span>
          </span>
        }
        actions={
          can("groups:write") && g.status === "active" ? (
            <>
              <button type="button" className="btn" onClick={() => setEditing(true)}>
                Modifier
              </button>
              <button type="button" className="btn btn-g" onClick={() => setArchiving(true)}>
                Archiver
              </button>
            </>
          ) : null
        }
      />
      <NextSessions group={g} onSeeAll={() => setTab("planning")} />
      <Tabs value={tab} tabs={tabs} onChange={setTab} />
      {tab === "students" ? (
        <Card
          title={
            <div className="row center" style={{ gap: 8, minWidth: 260 }}>
              <Bar value={(g.enrolledCount / g.capacity) * 100} tone={g.enrolledCount >= g.capacity ? "r" : undefined} />
              <span className="num">
                {g.enrolledCount}/{g.capacity} places
              </span>
            </div>
          }
          actions={
            can("enrolments:write") && g.status === "active" ? (
              <Link className="btn" to={`/inscriptions/nouvelle?groupe=${g.id}`}>
                + Inscrire un élève
              </Link>
            ) : null
          }
        >
          {g.students.length === 0 ? (
            <Empty title="Aucun élève inscrit" />
          ) : (
            <div className="xs">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Élève</th>
                    <th>Inscrit depuis</th>
                  </tr>
                </thead>
                <tbody>
                  {g.students.map((s) => (
                    <tr key={s.enrolmentId}>
                      <td>
                        <Link to={`/eleves/${s.studentId}`}>
                          {s.lastName} {s.firstName}
                        </Link>{" "}
                        {s.isMinor ? <Badge tone="amber">Mineur</Badge> : null}
                      </td>
                      <td>{frDate(s.effectiveDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="card-b cap">
            Règles de présence : absences justifiées {g.effective.countJustifiedAsPresent ? "comptées présentes" : "comptées absentes"}, rattrapages{" "}
            {g.effective.countMakeupAsPresent ? "comptés présents" : "non comptés"}
            {g.kind === "study" && g.effective.absenceBilled !== null ? `, absences ${g.effective.absenceBilled ? "facturées" : "non facturées"}` : ""}.
          </div>
        </Card>
      ) : null}
      {tab === "planning" ? <PlanningTab group={g} /> : null}
      {tab === "attendance" ? <AttendanceTab group={g} /> : null}
      {tab === "finance" ? <FinanceTab group={g} /> : null}
      {tab === "pay" ? <PayTab group={g} /> : null}
      {editing ? <EditGroupModal group={g} onClose={() => setEditing(false)} /> : null}
      {archiving ? (
        <ReasonDialog
          title="Archiver le groupe"
          explanation="Les inscriptions actives doivent d'abord être transférées ou clôturées."
          confirmLabel="Archiver"
          onClose={() => setArchiving(false)}
          onConfirm={async (reason) => {
            await api.post(`/groups/${id}/archive`, { reason });
            await client.invalidateQueries();
            toast("Groupe archivé.");
          }}
        />
      ) : null}
    </>
  );
}
