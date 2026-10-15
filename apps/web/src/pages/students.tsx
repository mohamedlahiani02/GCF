import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api/client";
import type { StudentRow } from "../api/types";
import { useSession } from "../auth/session";
import { usePage } from "../components/shell";
import { useToast } from "../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, PageHeader, Pagination } from "../components/ui";
import { frDate, tnd } from "../lib/format";

export interface StudentFormValues {
  firstName: string;
  lastName: string;
  birthDate: string;
  phone: string;
  email: string;
  receiptEmail: string;
  isMinor: boolean;
  guardianName: string;
  guardianPhone: string;
  guardianEmail: string;
  notes: string;
}

const EMPTY: StudentFormValues = {
  firstName: "",
  lastName: "",
  birthDate: "",
  phone: "",
  email: "",
  receiptEmail: "",
  isMinor: false,
  guardianName: "",
  guardianPhone: "",
  guardianEmail: "",
  notes: "",
};

export function toForm(s: StudentRow): StudentFormValues {
  return {
    firstName: s.firstName,
    lastName: s.lastName,
    birthDate: s.birthDate ?? "",
    phone: s.phone ?? "",
    email: s.email ?? "",
    receiptEmail: s.receiptEmail ?? "",
    isMinor: s.isMinor,
    guardianName: s.guardianName ?? "",
    guardianPhone: s.guardianPhone ?? "",
    guardianEmail: s.guardianEmail ?? "",
    notes: s.notes ?? "",
  };
}

function payload(v: StudentFormValues) {
  return {
    firstName: v.firstName,
    lastName: v.lastName,
    birthDate: v.birthDate || null,
    phone: v.phone,
    email: v.email,
    receiptEmail: v.receiptEmail,
    isMinor: v.isMinor,
    guardianName: v.guardianName,
    guardianPhone: v.guardianPhone,
    guardianEmail: v.guardianEmail,
    notes: v.notes,
  };
}

export function StudentFormModal({
  initial,
  studentId,
  onClose,
  onSaved,
}: {
  initial?: StudentFormValues;
  studentId?: string;
  onClose: () => void;
  onSaved: (s: StudentRow) => void;
}) {
  const [v, setV] = useState<StudentFormValues>(initial ?? EMPTY);
  const set = <K extends keyof StudentFormValues>(key: K, value: StudentFormValues[K]) => setV((old) => ({ ...old, [key]: value }));
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: () => (studentId ? api.patch<StudentRow>(`/students/${studentId}`, payload(v)) : api.post<StudentRow>("/students", payload(v))),
    onSuccess: async (s) => {
      await client.invalidateQueries();
      onSaved(s);
    },
  });
  const guardianMissing = v.isMinor && (!v.guardianName.trim() || (!v.guardianPhone.trim() && !v.guardianEmail.trim()));
  return (
    <Modal
      wide
      title={studentId ? "Modifier l'élève" : "Nouvel élève"}
      onClose={onClose}
      footer={
        <>
          <span className="cap">Les champs marqués * sont obligatoires</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-p"
              disabled={!v.firstName.trim() || !v.lastName.trim() || guardianMissing || save.isPending}
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
          <input className="input" value={v.firstName} onChange={(e) => set("firstName", e.target.value)} autoFocus />
        </Field>
        <Field label="Nom *">
          <input className="input" value={v.lastName} onChange={(e) => set("lastName", e.target.value)} />
        </Field>
        <Field label="Date de naissance">
          <input className="input" type="date" value={v.birthDate} onChange={(e) => set("birthDate", e.target.value)} />
        </Field>
        <Field label="Téléphone">
          <input className="input" value={v.phone} onChange={(e) => set("phone", e.target.value)} />
        </Field>
        <Field label="E-mail">
          <input className="input" type="email" value={v.email} onChange={(e) => set("email", e.target.value)} />
        </Field>
        <Field label="E-mail d'envoi des reçus">
          <input className="input" type="email" value={v.receiptEmail} onChange={(e) => set("receiptEmail", e.target.value)} />
        </Field>
      </div>
      <label className="row center" style={{ gap: 8 }}>
        <input type="checkbox" className="chk" checked={v.isMinor} onChange={(e) => set("isMinor", e.target.checked)} /> Élève mineur
      </label>
      {v.isMinor ? (
        <div className="grid3">
          <Field label="Parent ou tuteur *">
            <input className="input" value={v.guardianName} onChange={(e) => set("guardianName", e.target.value)} />
          </Field>
          <Field label="Téléphone du tuteur">
            <input className="input" value={v.guardianPhone} onChange={(e) => set("guardianPhone", e.target.value)} />
          </Field>
          <Field label="E-mail du tuteur">
            <input className="input" type="email" value={v.guardianEmail} onChange={(e) => set("guardianEmail", e.target.value)} />
          </Field>
        </div>
      ) : null}
      {guardianMissing ? <div className="err-text">Un élève mineur doit avoir un parent ou tuteur avec un téléphone ou un e-mail.</div> : null}
      <Field label="Notes">
        <textarea className="input" value={v.notes} onChange={(e) => set("notes", e.target.value)} />
      </Field>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

export function StudentsPage() {
  usePage(["Référentiels", "Élèves"]);
  const { can } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"active" | "archived" | "all">("active");
  const [minor, setMinor] = useState(false);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const pageSize = 25;
  const list = useQuery({
    queryKey: ["students", q, status, minor, page],
    queryFn: () => api.get<{ items: StudentRow[]; total: number }>("/students", { q, status, minor: minor ? "true" : undefined, page, pageSize }),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader
        title="Élèves"
        actions={
          can("students:write") ? (
            <button type="button" className="btn btn-p" onClick={() => setCreating(true)}>
              + Créer un élève
            </button>
          ) : null
        }
      />
      <Card
        title={
          <div className="row center" style={{ gap: 8 }}>
            <input
              className="input"
              style={{ width: 260 }}
              placeholder="Rechercher un nom, un téléphone"
              aria-label="Rechercher"
              value={q}
              onChange={(e) => (setQ(e.target.value), setPage(1))}
            />
            <select
              className="input"
              style={{ width: 160 }}
              aria-label="Statut"
              value={status}
              onChange={(e) => (setStatus(e.target.value as typeof status), setPage(1))}
            >
              <option value="active">Actifs</option>
              <option value="archived">Archivés</option>
              <option value="all">Tous</option>
            </select>
            <label className="row center" style={{ gap: 6 }}>
              <input type="checkbox" className="chk" checked={minor} onChange={(e) => (setMinor(e.target.checked), setPage(1))} /> Mineurs
            </label>
          </div>
        }
        footer={
          list.data ? <Pagination page={page} total={list.data.total} pageSize={pageSize} hasMore={page * pageSize < list.data.total} onPage={setPage} /> : null
        }
      >
        <ErrorBanner error={list.error} retry={() => list.refetch()} />
        {list.isPending ? (
          <Loading />
        ) : list.data && list.data.items.length === 0 ? (
          <Empty title="Aucun élève" text={q ? "Aucun élève ne correspond à cette recherche." : "Créez la première fiche élève."} />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Nom</th>
                  <th>Contact</th>
                  <th>Groupes actifs</th>
                  <th className="num">Reste à payer (TND)</th>
                  <th>Dernier paiement</th>
                </tr>
              </thead>
              <tbody>
                {list.data?.items.map((s) => (
                  <tr key={s.id} className="clickable" onClick={() => navigate(`/eleves/${s.id}`)}>
                    <td>
                      <Link to={`/eleves/${s.id}`} onClick={(e) => e.stopPropagation()}>
                        {s.lastName} {s.firstName}
                      </Link>{" "}
                      {s.isMinor ? <Badge tone="amber">Mineur</Badge> : null} {s.status === "archived" ? <Badge tone="gray">Archivé</Badge> : null}
                    </td>
                    <td>{s.isMinor && s.guardianName ? `${s.guardianName} · ${s.guardianPhone ?? s.guardianEmail ?? ""}` : (s.phone ?? s.email ?? "")}</td>
                    <td>{s.activeGroups?.join(", ")}</td>
                    <td className="num">{tnd(s.due ?? 0)}</td>
                    <td>{frDate(s.lastPaymentAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating ? (
        <StudentFormModal
          onClose={() => setCreating(false)}
          onSaved={(s) => {
            setCreating(false);
            toast("Élève créé.");
            navigate(`/eleves/${s.id}`);
          }}
        />
      ) : null}
    </>
  );
}
