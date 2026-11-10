import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import { usePage } from "../components/shell";
import { useToast } from "../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, Money, PageHeader, Tabs } from "../components/ui";
import { frDate, frDateTime } from "../lib/format";

type Kind = "reminders.send" | "payroll.calculate";
type Status = "pending" | "confirmed" | "rejected" | "expired" | "failed";
interface ReminderSummary {
  total: number;
  students: { studentId: string; name: string; recipient: string; total: number; oldestDueDate: string; installments: number }[];
  skipped: { noRecipient: number; remindedRecently: number; belowMinimum: number };
}
interface PayrollSummary {
  month: string;
  total: number;
  instructors: { instructorId: string; name: string; items: number; total: number }[];
  warnings: { instructorId: string; name: string; groupName: string | null; code: string; message: string }[];
}
interface Proposal {
  id: string;
  kind: Kind;
  title: string;
  summary: ReminderSummary | PayrollSummary;
  status: Status;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  result: unknown;
  error: string | null;
}

const STATUS: Record<Status, { label: string; tone: "amber" | "green" | "gray" | "red" }> = {
  pending: { label: "À confirmer", tone: "amber" },
  confirmed: { label: "Confirmée", tone: "green" },
  rejected: { label: "Refusée", tone: "gray" },
  expired: { label: "Expirée", tone: "gray" },
  failed: { label: "Échec", tone: "red" },
};
const CONFIRM_LABEL: Record<Kind, string> = { "reminders.send": "Envoyer les relances", "payroll.calculate": "Calculer la paie" };

function ReminderDetail({ summary }: { summary: ReminderSummary }) {
  const skipped = summary.skipped;
  return (
    <>
      <div className="xs">
        <table className="tbl">
          <thead>
            <tr>
              <th>Élève</th>
              <th>Destinataire</th>
              <th>Échéances</th>
              <th>Plus ancienne</th>
              <th style={{ textAlign: "right" }}>Dû</th>
            </tr>
          </thead>
          <tbody>
            {summary.students.map((s) => (
              <tr key={s.studentId}>
                <td>
                  <Link to={`/eleves/${s.studentId}`}>{s.name}</Link>
                </td>
                <td>{s.recipient}</td>
                <td className="num">{s.installments}</td>
                <td>{frDate(s.oldestDueDate)}</td>
                <td style={{ textAlign: "right" }}>
                  <Money value={s.total} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {skipped.noRecipient || skipped.remindedRecently || skipped.belowMinimum ? (
        <p className="cap card-b">
          Non relancés : {skipped.noRecipient} sans adresse e-mail, {skipped.remindedRecently} relancés récemment, {skipped.belowMinimum} sous le montant
          minimum.
        </p>
      ) : null}
    </>
  );
}

function PayrollDetail({ summary }: { summary: PayrollSummary }) {
  return (
    <>
      <div className="xs">
        <table className="tbl">
          <thead>
            <tr>
              <th>Prof / Formateur</th>
              <th>Éléments</th>
              <th style={{ textAlign: "right" }}>Montant</th>
            </tr>
          </thead>
          <tbody>
            {summary.instructors.map((i) => (
              <tr key={i.instructorId}>
                <td>
                  <Link to={`/paie/intervenants/${i.instructorId}`}>{i.name}</Link>
                </td>
                <td className="num">{i.items}</td>
                <td style={{ textAlign: "right" }}>
                  <Money value={i.total} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {summary.warnings.length ? (
        <div className="card-b stack" style={{ gap: 4 }}>
          <span className="lab">Points à vérifier avant de valider</span>
          {summary.warnings.map((w, index) => (
            <span key={`${w.instructorId}-${index}`} className="cap">
              {w.name}
              {w.groupName ? `, ${w.groupName}` : ""} : {w.message}
            </span>
          ))}
        </div>
      ) : null}
      <p className="cap card-b">Les éléments calculés restent à valider dans Paie : confirmer ne valide rien.</p>
    </>
  );
}

function DecisionModal({ proposal, approve, onClose }: { proposal: Proposal; approve: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState("");
  const decide = useMutation({
    mutationFn: () => api.post(`/automations/proposals/${proposal.id}/decision`, { approve, ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["proposals"] });
      await client.invalidateQueries({ queryKey: ["proposals-count"] });
      toast(approve ? "Proposition confirmée." : "Proposition refusée.");
      onClose();
    },
  });
  return (
    <Modal
      title={approve ? CONFIRM_LABEL[proposal.kind] : "Refuser la proposition"}
      onClose={onClose}
      footer={
        <>
          <span className="cap">Tracé au journal d'audit, à votre nom</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={decide.isPending} onClick={() => decide.mutate()}>
              {approve ? "Confirmer" : "Refuser"}
            </button>
          </div>
        </>
      }
    >
      <p>{proposal.title}</p>
      {approve && proposal.kind === "reminders.send" ? (
        <p className="cap">Les montants sont relus au moment de l'envoi : un élève qui a payé depuis ne reçoit rien.</p>
      ) : null}
      <Field label="Note (facultative)">
        <input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <ErrorBanner error={decide.error} />
    </Modal>
  );
}

function ProposalCard({ proposal }: { proposal: Proposal }) {
  const [deciding, setDeciding] = useState<boolean | null>(null);
  const pending = proposal.status === "pending";
  return (
    <Card
      title={
        <div className="row center" style={{ gap: 8 }}>
          {proposal.title}
          <Badge tone={STATUS[proposal.status].tone}>{STATUS[proposal.status].label}</Badge>
        </div>
      }
      footer={
        pending ? (
          <>
            <span className="cap">
              Préparée le {frDateTime(proposal.createdAt)}, expire le {frDateTime(proposal.expiresAt)}
            </span>
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn" onClick={() => setDeciding(false)}>
                Refuser
              </button>
              <button type="button" className="btn btn-p" onClick={() => setDeciding(true)}>
                {CONFIRM_LABEL[proposal.kind]}
              </button>
            </div>
          </>
        ) : (
          <span className="cap">
            {proposal.decidedAt
              ? `${STATUS[proposal.status].label} le ${frDateTime(proposal.decidedAt)} par ${proposal.decidedByName ?? "?"}`
              : `Préparée le ${frDateTime(proposal.createdAt)}`}
            {proposal.decisionNote ? ` : ${proposal.decisionNote}` : ""}
            {proposal.error ? ` (${proposal.error})` : ""}
          </span>
        )
      }
    >
      {proposal.kind === "reminders.send" ? (
        <ReminderDetail summary={proposal.summary as ReminderSummary} />
      ) : (
        <PayrollDetail summary={proposal.summary as PayrollSummary} />
      )}
      {deciding !== null ? <DecisionModal proposal={proposal} approve={deciding} onClose={() => setDeciding(null)} /> : null}
    </Card>
  );
}

export function ProposalsPage() {
  usePage(["Propositions"]);
  const [tab, setTab] = useState<"pending" | "decided">("pending");
  const list = useQuery({ queryKey: ["proposals", tab], queryFn: () => api.get<Proposal[]>("/automations/proposals", { status: tab }) });
  return (
    <>
      <PageHeader title="Propositions" subtitle="Le travail préparé par les automatisations du centre, à confirmer ou à refuser." />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "pending", label: "À confirmer" },
          { value: "decided", label: "Historique" },
        ]}
      />
      <ErrorBanner error={list.error} />
      {list.isPending ? (
        <Loading />
      ) : list.data?.length ? (
        <div className="stack">
          {list.data.map((p) => (
            <ProposalCard key={p.id} proposal={p} />
          ))}
        </div>
      ) : (
        <Card>
          <Empty
            title={tab === "pending" ? "Rien à confirmer" : "Aucune proposition"}
            text="Les automatisations se règlent dans Paramètres > Automatisations."
          />
        </Card>
      )}
    </>
  );
}
