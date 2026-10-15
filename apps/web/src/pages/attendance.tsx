import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../api/client";
import type { DaySession, Sheet, SheetRow } from "../api/types";
import { useSession } from "../auth/session";
import { usePage } from "../components/shell";
import { useToast } from "../components/toasts";
import { AttendanceBadge, Badge, Card, Empty, ErrorBanner, Field, Kpi, Loading, Modal, PageHeader } from "../components/ui";
import { addDaysIso, frDate, frTime, todayIso } from "../lib/format";
import { ATTENDANCE, SHEET } from "../lib/labels";

type Status = SheetRow["status"];
const STATUSES: Status[] = ["present", "absent", "absent_justified", "present_other_group"];

interface Draft {
  status: Status;
  note: string;
  hostSessionId: string | null;
}

export function AttendanceDayPage() {
  usePage(["Présences"]);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const date = params.get("date") ?? todayIso();
  const setDate = (d: string) => setParams({ date: d });
  const sessions = useQuery({ queryKey: ["sessions", date], queryFn: () => api.get<DaySession[]>("/sessions", { date }) });
  const list = sessions.data ?? [];
  const pending = list.filter((s) => s.status !== "cancelled" && s.sheetStatus !== "validated").length;
  return (
    <>
      <PageHeader
        title="Présences"
        subtitle={`${frDate(date)} · ${list.length} séance(s)${pending ? `, ${pending} feuille(s) à valider` : ""}`}
        actions={
          <div className="row center" style={{ gap: 6 }}>
            <button type="button" className="btn btn-g" aria-label="Jour précédent" onClick={() => setDate(addDaysIso(date, -1))}>
              ‹
            </button>
            <input className="input" type="date" aria-label="Date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
            <button type="button" className="btn btn-g" aria-label="Jour suivant" onClick={() => setDate(addDaysIso(date, 1))}>
              ›
            </button>
            <button type="button" className="btn" onClick={() => setDate(todayIso())}>
              Aujourd'hui
            </button>
          </div>
        }
      />
      <Card>
        <ErrorBanner error={sessions.error} retry={() => sessions.refetch()} />
        {sessions.isPending ? (
          <Loading />
        ) : list.length === 0 ? (
          <Empty title="Aucune séance ce jour" text="Les séances apparaissent une fois générées depuis le planning des groupes." />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Horaire</th>
                  <th>Groupe</th>
                  <th>Intervenant</th>
                  <th>Salle</th>
                  <th>Feuille</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr
                    key={s.id}
                    className={s.status === "cancelled" ? "dim" : "clickable"}
                    onClick={() => s.status !== "cancelled" && navigate(`/presences/${s.id}`)}
                  >
                    <td>
                      {frTime(s.startsAt)}-{frTime(s.endsAt)}
                    </td>
                    <td>{s.groupName}</td>
                    <td>
                      {s.instructorFirstName} {s.instructorLastName}
                    </td>
                    <td>{s.roomName ?? ""}</td>
                    <td>
                      {s.status === "cancelled" ? (
                        <Badge tone="gray" strike>
                          Séance annulée
                        </Badge>
                      ) : (
                        <Badge tone={SHEET[s.sheetStatus]!.tone}>{SHEET[s.sheetStatus]!.label}</Badge>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {s.status !== "cancelled" ? (
                        <Link className="btn btn-g" to={`/presences/${s.id}`} onClick={(e) => e.stopPropagation()}>
                          {s.sheetStatus === "validated" ? "Consulter" : "Faire l'appel"}
                        </Link>
                      ) : null}
                    </td>
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

function HostPicker({ sheet, value, onChange }: { sheet: Sheet; value: string | null; onChange: (id: string | null) => void }) {
  const day = useQuery({
    queryKey: ["sessions", sheet.session.localDate],
    queryFn: () => api.get<DaySession[]>("/sessions", { date: sheet.session.localDate }),
  });
  const options = (day.data ?? []).filter((s) => s.groupId !== sheet.session.groupId && s.status !== "cancelled" && s.sheetStatus !== "validated");
  return (
    <select className={`input${value ? "" : " err"}`} aria-label="Séance de rattrapage" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">Séance suivie…</option>
      {options.map((s) => (
        <option key={s.id} value={s.id}>
          {s.groupName} · {frTime(s.startsAt)}
        </option>
      ))}
    </select>
  );
}

function CorrectionModal({ sheet, row, onClose }: { sheet: Sheet; row: SheetRow; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<Status>(row.status);
  const [note, setNote] = useState(row.note ?? "");
  const [hostSessionId, setHostSessionId] = useState<string | null>(row.hostSessionId);
  const [reason, setReason] = useState("");
  const correct = useMutation({
    mutationFn: () =>
      api.post(`/sessions/${sheet.session.id}/attendance/correct`, {
        studentId: row.studentId,
        status,
        note: note.trim() || null,
        hostSessionId: status === "present_other_group" ? hostSessionId : null,
        reason: reason.trim(),
      }),
    onSuccess: async () => {
      await client.invalidateQueries();
      toast("Présence corrigée. Les échéances à la séance sont recalculées si besoin.");
      onClose();
    },
  });
  return (
    <Modal
      title={`Corriger : ${row.lastName} ${row.firstName}`}
      onClose={onClose}
      footer={
        <>
          <span className="cap">Correction tracée au journal d'audit</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-p"
              disabled={!reason.trim() || (status === "present_other_group" && !hostSessionId) || correct.isPending}
              onClick={() => correct.mutate()}
            >
              Corriger
            </button>
          </div>
        </>
      }
    >
      <Field label="Statut">
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value as Status)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {ATTENDANCE[s]!.label}
            </option>
          ))}
        </select>
      </Field>
      {status === "present_other_group" ? <HostPicker sheet={sheet} value={hostSessionId} onChange={setHostSessionId} /> : null}
      <Field label="Note">
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Field label="Motif de la correction (obligatoire)">
        <textarea className="input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorBanner error={correct.error} />
    </Modal>
  );
}

export function AttendanceSheetPage() {
  const { sessionId = "" } = useParams();
  const { can } = useSession();
  const client = useQueryClient();
  const toast = useToast();
  const sheet = useQuery({ queryKey: ["sheet", sessionId], queryFn: () => api.get<Sheet>(`/sessions/${sessionId}/sheet`) });
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [dirty, setDirty] = useState(false);
  const [correcting, setCorrecting] = useState<SheetRow | null>(null);
  usePage(["Présences", sheet.data ? `${sheet.data.session.groupName}, ${frDate(sheet.data.session.localDate)}` : "Feuille"]);

  useEffect(() => {
    if (sheet.data && !dirty) {
      setDrafts(
        Object.fromEntries(
          sheet.data.rows.filter((r) => !r.isGuest).map((r) => [r.studentId, { status: r.status, note: r.note ?? "", hostSessionId: r.hostSessionId }]),
        ),
      );
    }
  }, [sheet.data, dirty]);

  const records = () =>
    Object.entries(drafts).map(([studentId, d]) => ({
      studentId,
      status: d.status,
      note: d.note.trim() || null,
      hostSessionId: d.status === "present_other_group" ? d.hostSessionId : null,
    }));
  const save = useMutation({
    mutationFn: () => api.put(`/sessions/${sessionId}/attendance`, { records: records() }),
    onSuccess: async () => {
      setDirty(false);
      await client.invalidateQueries({ queryKey: ["sheet", sessionId] });
      toast("Feuille enregistrée.");
    },
  });
  const validate = useMutation({
    mutationFn: async () => {
      await api.put(`/sessions/${sessionId}/attendance`, { records: records() });
      return api.post(`/sessions/${sessionId}/validate`);
    },
    onSuccess: async () => {
      setDirty(false);
      await client.invalidateQueries();
      toast("Feuille validée.");
    },
  });

  if (sheet.isPending) return <Loading />;
  if (sheet.error) return <ErrorBanner error={sheet.error} retry={() => sheet.refetch()} />;
  const s = sheet.data;
  const validated = s.session.sheetStatus === "validated";
  const editable = !validated && s.session.status !== "cancelled" && can("attendance:write");
  const members = s.rows.filter((r) => !r.isGuest);
  const guests = s.rows.filter((r) => r.isGuest);
  const count = (status: Status) => members.filter((r) => (drafts[r.studentId]?.status ?? r.status) === status).length;
  const missingHost = Object.values(drafts).some((d) => d.status === "present_other_group" && !d.hostSessionId);
  const setDraft = (studentId: string, patch: Partial<Draft>) => {
    setDirty(true);
    setDrafts((all) => ({ ...all, [studentId]: { ...all[studentId]!, ...patch } }));
  };
  const started = new Date(s.session.startsAt).getTime() <= Date.now();

  return (
    <>
      <PageHeader
        title={s.session.groupName}
        subtitle={
          <span className="row center" style={{ gap: 8 }}>
            <span>
              {frDate(s.session.localDate)} · {frTime(s.session.startsAt)}-{frTime(s.session.endsAt)}
            </span>
            <Badge tone={SHEET[s.session.sheetStatus]!.tone}>{SHEET[s.session.sheetStatus]!.label}</Badge>
            {s.session.status === "cancelled" ? <Badge tone="gray">Séance annulée</Badge> : null}
          </span>
        }
        actions={
          <>
            <Link className="btn btn-g" to={`/groupes/${s.session.groupId}`}>
              Fiche du groupe
            </Link>
            <a className="btn" href={api.fileUrl(`/sessions/${sessionId}/sheet.pdf`)} target="_blank" rel="noreferrer">
              Feuille A4 à imprimer
            </a>
          </>
        }
      />
      <div className="grid4">
        <Kpi label="Présents" value={count("present")} />
        <Kpi label="Absents" value={count("absent")} tone={count("absent") ? "red" : undefined} />
        <Kpi label="Absents justifiés" value={count("absent_justified")} />
        <Kpi
          label="En rattrapage ailleurs"
          value={count("present_other_group")}
          sub={guests.length ? `${guests.length} invité(s) en rattrapage ici` : undefined}
        />
      </div>
      {validated ? (
        <div className="ban ban-green">
          <span>
            Feuille validée et verrouillée.
            {can("attendance:correct") ? " Une correction reste possible avec un motif." : " Seul l'administrateur peut la corriger."}
          </span>
        </div>
      ) : editable ? (
        <div className="ban ban-blue">
          <span>Chaque élève est présent par défaut : ne changez que les absences et les rattrapages.</span>
        </div>
      ) : null}
      <Card
        title="Appel"
        footer={
          editable ? (
            <>
              <span className="cap">{dirty ? "Modifications non enregistrées" : "À jour"}</span>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn" disabled={!dirty || missingHost || save.isPending} onClick={() => save.mutate()}>
                  Enregistrer
                </button>
                <button
                  type="button"
                  className="btn btn-p"
                  disabled={!started || missingHost || validate.isPending}
                  title={started ? undefined : "La feuille se valide une fois la séance commencée"}
                  onClick={() => validate.mutate()}
                >
                  Valider la feuille
                </button>
              </div>
            </>
          ) : null
        }
      >
        <ErrorBanner error={save.error ?? validate.error} />
        {members.length === 0 ? (
          <Empty title="Aucun élève inscrit à cette date" />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Élève</th>
                  <th>Statut</th>
                  <th>Note</th>
                  {validated && can("attendance:correct") ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {members.map((r) => {
                  const d = drafts[r.studentId] ?? { status: r.status, note: r.note ?? "", hostSessionId: r.hostSessionId };
                  return (
                    <tr key={r.studentId}>
                      <td>
                        <Link to={`/eleves/${r.studentId}`}>
                          {r.lastName} {r.firstName}
                        </Link>
                        {!r.saved && !validated ? <div className="cap">présent par défaut</div> : null}
                      </td>
                      <td>
                        {editable ? (
                          <div className="stack" style={{ gap: 6 }}>
                            <div className="seg" role="group" aria-label={`Statut de ${r.firstName} ${r.lastName}`}>
                              {STATUSES.map((st) => (
                                <button
                                  key={st}
                                  type="button"
                                  className="btn"
                                  aria-pressed={d.status === st}
                                  title={ATTENDANCE[st]!.label}
                                  onClick={() => setDraft(r.studentId, { status: st })}
                                >
                                  {ATTENDANCE[st]!.label}
                                </button>
                              ))}
                            </div>
                            {d.status === "present_other_group" ? (
                              <HostPicker sheet={s} value={d.hostSessionId} onChange={(id) => setDraft(r.studentId, { hostSessionId: id })} />
                            ) : null}
                          </div>
                        ) : (
                          <AttendanceBadge status={r.status} />
                        )}
                      </td>
                      <td>
                        {editable ? (
                          <input
                            className="input"
                            aria-label={`Note pour ${r.firstName} ${r.lastName}`}
                            value={d.note}
                            onChange={(e) => setDraft(r.studentId, { note: e.target.value })}
                          />
                        ) : (
                          (r.note ?? "")
                        )}
                      </td>
                      {validated && can("attendance:correct") ? (
                        <td style={{ textAlign: "right" }}>
                          <button type="button" className="btn btn-g" onClick={() => setCorrecting(r)}>
                            Corriger
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {guests.length ? (
        <Card title="Invités en rattrapage">
          <div className="xs">
            <table className="tbl">
              <tbody>
                {guests.map((r) => (
                  <tr key={r.studentId}>
                    <td>
                      {r.lastName} {r.firstName}
                    </td>
                    <td>
                      <Badge tone="blue">Groupe d'origine : {r.originGroupName}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-b cap">
            Un invité est compté présent dans son groupe d'origine, selon le réglage des rattrapages ; il ne compte pas dans le taux de ce groupe.
          </div>
        </Card>
      ) : null}
      {correcting ? <CorrectionModal sheet={s} row={correcting} onClose={() => setCorrecting(null)} /> : null}
    </>
  );
}
