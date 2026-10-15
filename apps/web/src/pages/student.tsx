import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api/client";
import type { EnrolmentRow, GroupDetail, GroupRow, Installment, PaymentRow, StudentAccount, StudentRow } from "../api/types";
import { useSession } from "../auth/session";
import { usePage, useCollect } from "../components/shell";
import { useToast } from "../components/toasts";
import {
  AttendanceBadge,
  Badge,
  Card,
  Empty,
  ErrorBanner,
  Field,
  Kpi,
  Loading,
  Modal,
  PageHeader,
  ReasonDialog,
  Segmented,
  StateBadge,
  Tabs,
  Bar,
  rateTone,
} from "../components/ui";
import { errorMessage } from "../lib/errors";
import { CHEQUE, METHOD, PAYMENT_MODE } from "../lib/labels";
import { frDate, frDateTime, percent, tnd, todayIso, tryParseTnd } from "../lib/format";
import { StudentFormModal, toForm } from "./students";

type Tab = "summary" | "enrolments" | "payments" | "attendance" | "documents" | "history";

const ENROLMENT_STATUS: Record<EnrolmentRow["status"], { label: string; tone: "green" | "blue" | "gray" | "teal" }> = {
  active: { label: "Active", tone: "green" },
  transferred: { label: "Transférée", tone: "blue" },
  dropped: { label: "Abandon", tone: "gray" },
  completed: { label: "Terminée", tone: "teal" },
};

/** Next statuses a cheque may take, mirroring the server's life cycle. */
const CHEQUE_NEXT: Record<string, ("deposited" | "cashed" | "bounced")[]> = {
  received: ["deposited", "cashed", "bounced"],
  deposited: ["cashed", "bounced"],
  cashed: ["bounced"],
  bounced: [],
};

function TransferModal({ enrolment, onClose }: { enrolment: EnrolmentRow; onClose: () => void }) {
  const toast = useToast();
  const client = useQueryClient();
  const current = useQuery({ queryKey: ["group", enrolment.groupId], queryFn: () => api.get<GroupDetail>(`/groups/${enrolment.groupId}`) });
  const filter = current.data
    ? current.data.kind === "study"
      ? { studyId: current.data.studyId }
      : { trainingSessionId: current.data.trainingSessionId }
    : null;
  const candidates = useQuery({
    queryKey: ["groups", filter],
    queryFn: () => api.get<GroupRow[]>("/groups", filter ?? {}),
    enabled: !!filter,
  });
  const [groupId, setGroupId] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(todayIso());
  const [mode, setMode] = useState<"keep" | "reprice">("keep");
  const [reason, setReason] = useState("");
  const monthly = enrolment.paymentMode === "monthly";
  const transfer = useMutation({
    mutationFn: () =>
      api.post<{ movedInstallments: number; cancelledTotal: number; issuedTotal: number }>(`/enrolments/${enrolment.id}/transfer`, {
        newGroupId: groupId,
        effectiveDate,
        mode,
        reason: reason.trim(),
      }),
    onSuccess: async (r) => {
      await client.invalidateQueries();
      toast(
        mode === "reprice"
          ? `Groupe changé. Échéances recalculées : ${tnd(r.cancelledTotal)} TND annulés, ${tnd(r.issuedTotal)} TND émis.`
          : `Groupe changé. ${r.movedInstallments} échéance(s) conservée(s) sur la nouvelle inscription.`,
      );
      onClose();
    },
  });
  const options = (candidates.data ?? []).filter((g) => g.id !== enrolment.groupId);
  return (
    <Modal
      wide
      title="Changer de groupe"
      onClose={onClose}
      footer={
        <>
          <span className="cap">Action tracée au journal d'audit</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!groupId || !reason.trim() || transfer.isPending} onClick={() => transfer.mutate()}>
              Confirmer le changement
            </button>
          </div>
        </>
      }
    >
      <div className="cap">
        Groupe actuel : <strong>{enrolment.groupName}</strong> depuis le {frDate(enrolment.effectiveDate)}. Le changement reste dans la même{" "}
        {enrolment.kind === "study" ? "étude" : "formation"}.
      </div>
      <ErrorBanner error={current.error ?? candidates.error} />
      <Field label="Nouveau groupe *">
        <select className="input" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">Choisir un groupe</option>
          {options.map((g) => (
            <option key={g.id} value={g.id} disabled={g.enrolledCount >= g.capacity}>
              {g.name} · {g.instructorLastName} {g.instructorFirstName} · {g.enrolledCount}/{g.capacity}
              {g.enrolledCount >= g.capacity ? " (complet)" : ""}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Date d'effet *">
        <input className="input" type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
      </Field>
      <div>
        <div className="lab" style={{ marginBottom: 6 }}>
          Échéances
        </div>
        <Segmented
          label="Traitement des échéances"
          value={mode}
          onChange={setMode}
          options={[
            { value: "keep", label: "Conserver le plan actuel" },
            { value: "reprice", label: "Recalculer au tarif du nouveau groupe", disabled: !monthly },
          ]}
        />
        <div className="cap" style={{ marginTop: 6 }}>
          {mode === "keep"
            ? "Les échéances à venir sont rattachées à la nouvelle inscription, sans changer de montant."
            : "Les mois non payés à partir du mois d'effet sont annulés puis réémis au tarif du nouveau groupe. Les paiements déjà reçus restent acquis."}
          {!monthly ? " Le recalcul ne s'applique qu'à la facturation mensuelle." : ""}
        </div>
      </div>
      <Field label="Motif (obligatoire)">
        <textarea className="input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorBanner error={transfer.error} />
    </Modal>
  );
}

function PostponeModal({ installment, onClose }: { installment: Installment; onClose: () => void }) {
  const toast = useToast();
  const client = useQueryClient();
  const [toDate, setToDate] = useState("");
  const [reason, setReason] = useState("");
  const postpone = useMutation({
    mutationFn: () => api.post<{ id: string; status: "approved" | "pending" }>(`/installments/${installment.id}/postpone`, { toDate, reason: reason.trim() }),
    onSuccess: async (r) => {
      await client.invalidateQueries();
      toast(r.status === "approved" ? `Échéance reportée au ${frDate(toDate)}.` : "Report enregistré : il attend la validation d'un administrateur.");
      onClose();
    },
  });
  return (
    <Modal
      title="Reporter une échéance"
      onClose={onClose}
      footer={
        <>
          <span className="cap">La date d'origine reste visible</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-p"
              disabled={!toDate || toDate <= installment.dueDate || !reason.trim() || postpone.isPending}
              onClick={() => postpone.mutate()}
            >
              Reporter
            </button>
          </div>
        </>
      }
    >
      <div className="grid2">
        <div>
          <div className="lab">Échéance</div>
          <strong>{installment.label}</strong>
          <div className="cap">Reste dû : {tnd(installment.remaining)} TND</div>
        </div>
        <div>
          <div className="lab">Date actuelle</div>
          <strong>{frDate(installment.dueDate)}</strong>
          {installment.postponementCount > 0 ? (
            <div className="cap">
              Déjà reportée {installment.postponementCount} fois (origine {frDate(installment.originalDueDate)})
            </div>
          ) : null}
        </div>
      </div>
      <Field label="Nouvelle date *" error={toDate && toDate <= installment.dueDate ? "La nouvelle date doit être postérieure à la date actuelle." : null}>
        <input className="input" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
      </Field>
      <Field label="Motif (obligatoire)">
        <textarea className="input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorBanner error={postpone.error} />
    </Modal>
  );
}

function ChequeModal({ payment, onClose }: { payment: PaymentRow; onClose: () => void }) {
  const toast = useToast();
  const client = useQueryClient();
  const next = CHEQUE_NEXT[payment.chequeStatus ?? "received"] ?? [];
  const [status, setStatus] = useState(next[0] ?? "cashed");
  const [reason, setReason] = useState("");
  const update = useMutation({
    mutationFn: () => api.post(`/payments/${payment.id}/cheque-status`, { status, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
    onSuccess: async () => {
      await client.invalidateQueries();
      toast(status === "bounced" ? "Chèque impayé : les échéances qu'il réglait sont de nouveau dues." : `Chèque marqué « ${CHEQUE[status]} ».`);
      onClose();
    },
  });
  return (
    <Modal
      title={`Chèque ${payment.chequeNumber ?? ""}`}
      onClose={onClose}
      footer={
        <>
          <span className="cap">Statut actuel : {CHEQUE[payment.chequeStatus ?? "received"]}</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button
              type="button"
              className={status === "bounced" ? "btn btn-d" : "btn btn-p"}
              disabled={!next.length || (status === "bounced" && !reason.trim()) || update.isPending}
              onClick={() => update.mutate()}
            >
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <Field label="Nouveau statut">
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          {next.map((s) => (
            <option key={s} value={s}>
              {CHEQUE[s]}
            </option>
          ))}
        </select>
      </Field>
      {status === "bounced" ? (
        <>
          <div className="ban ban-amber">
            <span>Un chèque impayé cesse de régler ses échéances : elles redeviennent dues.</span>
          </div>
          <Field label="Motif (obligatoire)">
            <textarea className="input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </>
      ) : null}
      <ErrorBanner error={update.error} />
    </Modal>
  );
}

function RefundModal({ studentId, credit, onClose }: { studentId: string; credit: number; onClose: () => void }) {
  const toast = useToast();
  const client = useQueryClient();
  const [amountText, setAmountText] = useState("");
  const [method, setMethod] = useState<"cash" | "transfer" | "cheque" | "card">("cash");
  const [chequeNumber, setChequeNumber] = useState("");
  const [chequeBank, setChequeBank] = useState("");
  const [reason, setReason] = useState("");
  const amount = tryParseTnd(amountText);
  const refund = useMutation({
    mutationFn: () =>
      api.post<{ paymentId: string; receipt: { id: string; number: string } }>("/payments/refunds", {
        studentId,
        amount,
        method,
        ...(method === "cheque" ? { cheque: { number: chequeNumber.trim(), bank: chequeBank.trim() } } : {}),
        reason: reason.trim(),
      }),
    onSuccess: async (r) => {
      await client.invalidateQueries();
      toast(`Remboursement enregistré. Reçu ${r.receipt.number}.`);
      window.open(api.fileUrl(`/receipts/${r.receipt.id}/pdf`), "_blank", "noopener");
      onClose();
    },
  });
  const valid = amount !== null && amount > 0 && amount <= credit && reason.trim() && (method !== "cheque" || (chequeNumber.trim() && chequeBank.trim()));
  return (
    <Modal
      title="Rembourser le solde créditeur"
      onClose={onClose}
      footer={
        <>
          <span className="cap">Un reçu de remboursement est émis</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!valid || refund.isPending} onClick={() => refund.mutate()}>
              Rembourser
            </button>
          </div>
        </>
      }
    >
      <div className="cap">Solde créditeur disponible : {tnd(credit)} TND</div>
      <Field
        label="Montant (TND) *"
        error={amount !== null && amount > credit ? "Le montant dépasse le solde créditeur." : amountText && amount === null ? "Montant invalide" : null}
      >
        <input className="input num" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
      </Field>
      <Segmented
        label="Mode de remboursement"
        value={method}
        onChange={setMethod}
        options={(["cash", "transfer", "cheque", "card"] as const).map((m) => ({ value: m, label: METHOD[m] ?? m }))}
      />
      {method === "cheque" ? (
        <div className="grid2">
          <Field label="N° de chèque">
            <input className="input" value={chequeNumber} onChange={(e) => setChequeNumber(e.target.value)} />
          </Field>
          <Field label="Banque">
            <input className="input" value={chequeBank} onChange={(e) => setChequeBank(e.target.value)} />
          </Field>
        </div>
      ) : null}
      <Field label="Motif (obligatoire)">
        <textarea className="input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorBanner error={refund.error} />
    </Modal>
  );
}

function AttendanceTab({ studentId, enrolments }: { studentId: string; enrolments: EnrolmentRow[] }) {
  const today = todayIso();
  const results = useQuery({
    queryKey: ["student-attendance", studentId, enrolments.map((e) => e.id).join(",")],
    queryFn: () =>
      Promise.all(
        enrolments.map(async (e) => {
          const data = await api.get<{
            sessions: { id: string; localDate: string }[];
            rows: { studentId: string; cells: Record<string, string>; rateBasisPoints: number | null }[];
          }>(`/groups/${e.groupId}/attendance`, { from: e.effectiveDate, to: e.endDate && e.endDate < today ? e.endDate : today });
          return { enrolment: e, sessions: data.sessions, row: data.rows.find((r) => r.studentId === studentId) ?? null };
        }),
      ),
    enabled: enrolments.length > 0,
  });
  if (!enrolments.length) return <Empty title="Aucune inscription" />;
  if (results.isPending) return <Loading />;
  if (results.error) return <ErrorBanner error={results.error} retry={() => results.refetch()} />;
  return (
    <div className="stack">
      {results.data.map(({ enrolment, sessions, row }) => (
        <Card
          key={enrolment.id}
          title={
            <div className="row center" style={{ gap: 10 }}>
              <h2 className="h2">{enrolment.groupName}</h2>
              <span className="cap">
                du {frDate(enrolment.effectiveDate)}
                {enrolment.endDate ? ` au ${frDate(enrolment.endDate)}` : ""}
              </span>
            </div>
          }
          actions={
            row?.rateBasisPoints !== null && row?.rateBasisPoints !== undefined ? (
              <div className="row center" style={{ gap: 8, minWidth: 200 }}>
                <Bar value={row.rateBasisPoints / 100} tone={rateTone(row.rateBasisPoints)} />
                <strong className="num">{percent(row.rateBasisPoints)}</strong>
              </div>
            ) : null
          }
        >
          {sessions.length === 0 ? (
            <div className="card-b cap">Aucune feuille validée sur la période.</div>
          ) : (
            <div className="xs">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Séance</th>
                    <th>Statut</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions
                    .filter((s) => row?.cells[s.id])
                    .map((s) => (
                      <tr key={s.id}>
                        <td>{frDate(s.localDate)}</td>
                        <td>
                          <AttendanceBadge status={row!.cells[s.id]!} />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

export function StudentPage() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const collect = useCollect();
  const toast = useToast();
  const client = useQueryClient();
  const [tab, setTab] = useState<Tab>("summary");
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [transfer, setTransfer] = useState<EnrolmentRow | null>(null);
  const [drop, setDrop] = useState<EnrolmentRow | null>(null);
  const [dropDate, setDropDate] = useState(todayIso());
  const [postpone, setPostpone] = useState<Installment | null>(null);
  const [cheque, setCheque] = useState<PaymentRow | null>(null);
  const [cancelPayment, setCancelPayment] = useState<PaymentRow | null>(null);
  const [refund, setRefund] = useState(false);
  const [rejectDiscount, setRejectDiscount] = useState<Installment | null>(null);

  const student = useQuery({ queryKey: ["student", id], queryFn: () => api.get<StudentRow>(`/students/${id}`) });
  const account = useQuery({
    queryKey: ["account", `/students/${id}/account`],
    queryFn: () => api.get<StudentAccount>(`/students/${id}/account`),
    enabled: can("payments:read"),
  });
  const enrolments = useQuery({ queryKey: ["enrolments", { studentId: id }], queryFn: () => api.get<EnrolmentRow[]>("/enrolments", { studentId: id }) });
  const name = student.data ? `${student.data.firstName} ${student.data.lastName}` : "Fiche élève";
  usePage(["Élèves", name]);

  const decideDiscount = useMutation({
    mutationFn: (input: { id: string; approve: boolean; reason?: string }) =>
      api.post(`/enrolments/discounts/${input.id}/decision`, { approve: input.approve, ...(input.reason ? { reason: input.reason } : {}) }),
    onSuccess: async (_r, input) => {
      await client.invalidateQueries();
      toast(input.approve ? "Remise approuvée." : "Remise refusée.");
    },
    onError: (error) => toast(errorMessage(error), "error"),
  });

  if (student.isPending) return <Loading />;
  if (student.error) return <ErrorBanner error={student.error} retry={() => student.refetch()} />;
  const s = student.data;
  const totals = account.data?.totals;
  const installments = account.data?.installments ?? [];
  const payments = account.data?.payments ?? [];
  const activeEnrolments = (enrolments.data ?? []).filter((e) => e.status === "active");
  const tabs: { value: Tab; label: string }[] = [
    { value: "summary", label: "Résumé" },
    { value: "enrolments", label: "Inscriptions" },
    ...(can("payments:read") ? [{ value: "payments" as const, label: "Paiements" }] : []),
    { value: "attendance", label: "Présences" },
    ...(can("payments:read") ? [{ value: "documents" as const, label: "Documents" }] : []),
    ...(can("payments:read") ? [{ value: "history" as const, label: "Historique" }] : []),
  ];

  return (
    <>
      <PageHeader
        title={name}
        subtitle={
          <span className="row center" style={{ gap: 8 }}>
            {s.status === "archived" ? <Badge tone="gray">Archivé</Badge> : <Badge tone="green">Actif</Badge>}
            {s.isMinor ? <Badge tone="amber">Mineur</Badge> : null}
            <span>{[s.phone, s.email].filter(Boolean).join(" · ")}</span>
            {s.isMinor && s.guardianName ? <span>Tuteur : {[s.guardianName, s.guardianPhone, s.guardianEmail].filter(Boolean).join(" · ")}</span> : null}
          </span>
        }
        actions={
          <>
            {can("payments:write") && s.status === "active" ? (
              <button type="button" className="btn btn-p" onClick={() => collect({ studentId: id })}>
                Encaisser
              </button>
            ) : null}
            {can("enrolments:write") && s.status === "active" ? (
              <Link className="btn" to={`/inscriptions/nouvelle?eleve=${id}`}>
                Nouvelle inscription
              </Link>
            ) : null}
            {can("students:write") ? (
              <>
                <button type="button" className="btn" onClick={() => setEditing(true)}>
                  Modifier
                </button>
                <button type="button" className="btn btn-g" onClick={() => setArchiving(true)}>
                  {s.status === "archived" ? "Restaurer" : "Archiver"}
                </button>
              </>
            ) : null}
          </>
        }
      />

      {totals ? (
        <div className="grid4">
          <Kpi
            label="Reste à payer"
            value={<span className="num">{tnd(totals.due)}</span>}
            sub="TND"
            tone={installments.some((i) => i.state === "overdue") ? "red" : undefined}
          />
          <Kpi label="Solde créditeur" value={<span className="num">{tnd(totals.credit)}</span>} sub="TND, imputé aux prochaines échéances" />
          <Kpi
            label="Remises en attente"
            value={<span className="num">{tnd(totals.pendingDiscounts)}</span>}
            sub="TND, à valider par l'administrateur"
            tone={totals.pendingDiscounts > 0 ? "amber" : undefined}
          />
          <Kpi label="Groupes actifs" value={activeEnrolments.length} sub={activeEnrolments.map((e) => e.groupName).join(", ") || "Aucun"} />
        </div>
      ) : null}

      <Tabs value={tab} tabs={tabs} onChange={setTab} />
      <ErrorBanner error={account.error ?? enrolments.error} />

      {tab === "summary" ? (
        can("payments:read") ? (
          <Card
            title="Échéancier"
            actions={
              can("payments:cancel") && totals && totals.credit > 0 ? (
                <button type="button" className="btn" onClick={() => setRefund(true)}>
                  Rembourser le crédit
                </button>
              ) : null
            }
          >
            {installments.length === 0 ? (
              <Empty title="Aucune échéance" text="Les échéances apparaissent à l'inscription." />
            ) : (
              <div className="xs">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Échéance</th>
                      <th>Date</th>
                      <th>Statut</th>
                      <th className="num">Montant</th>
                      <th className="num">Payé</th>
                      <th className="num">Reste</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {installments.map((i) => (
                      <tr key={i.id}>
                        <td>{i.label}</td>
                        <td>
                          {frDate(i.dueDate)}
                          {i.dueDate !== i.originalDueDate ? <div className="cap">origine {frDate(i.originalDueDate)}</div> : null}
                        </td>
                        <td>
                          <StateBadge state={i.state} />
                        </td>
                        <td className="num">{i.kind === "discount" ? `-${tnd(i.amount)}` : tnd(i.amount)}</td>
                        <td className="num">{i.kind === "charge" ? tnd(i.paid) : ""}</td>
                        <td className="num">{i.kind === "charge" && i.status === "open" ? tnd(i.remaining) : ""}</td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          {i.kind === "charge" && i.status === "open" && i.remaining > 0 && can("payments:write") ? (
                            <button type="button" className="btn btn-g" onClick={() => setPostpone(i)}>
                              Reporter
                            </button>
                          ) : null}
                          {i.state === "pending_discount" && can("discounts:approve") ? (
                            <>
                              <button
                                type="button"
                                className="btn btn-g"
                                disabled={decideDiscount.isPending}
                                onClick={() => decideDiscount.mutate({ id: i.id, approve: true })}
                              >
                                Approuver
                              </button>
                              <button type="button" className="btn btn-g" onClick={() => setRejectDiscount(i)}>
                                Refuser
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
            {account.data?.postponements.some((p) => p.status === "pending") ? (
              <div className="card-b">
                <div className="ban ban-amber">
                  <span>Un report attend la validation d'un administrateur.</span>
                </div>
              </div>
            ) : null}
          </Card>
        ) : (
          <Card title="Informations">
            <div className="card-b stack">
              <div>Né(e) le {frDate(s.birthDate) || "non renseigné"}</div>
              {s.notes ? <div>{s.notes}</div> : null}
            </div>
          </Card>
        )
      ) : null}

      {tab === "enrolments" ? (
        <Card title="Inscriptions">
          {enrolments.data && enrolments.data.length === 0 ? (
            <Empty title="Aucune inscription" />
          ) : (
            <div className="xs">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Groupe</th>
                    <th>Offre</th>
                    <th>Paiement</th>
                    <th>Période</th>
                    <th>Statut</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {enrolments.data?.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <Link to={`/groupes/${e.groupId}`}>{e.groupName}</Link>
                      </td>
                      <td>{e.studyName ?? e.trainingTitle}</td>
                      <td>{PAYMENT_MODE[e.paymentMode] ?? e.paymentMode}</td>
                      <td>
                        {frDate(e.effectiveDate)}
                        {e.endDate ? ` au ${frDate(e.endDate)}` : ""}
                        {e.endedReason ? <div className="cap">{e.endedReason}</div> : null}
                      </td>
                      <td>
                        <Badge tone={ENROLMENT_STATUS[e.status].tone}>{ENROLMENT_STATUS[e.status].label}</Badge>
                      </td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        {e.status === "active" && can("enrolments:write") ? (
                          <>
                            <button type="button" className="btn btn-g" onClick={() => setTransfer(e)}>
                              Changer de groupe
                            </button>
                            <button type="button" className="btn btn-g" onClick={() => setDrop(e)}>
                              Abandon
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
      ) : null}

      {tab === "payments" ? (
        <Card title="Paiements">
          {payments.length === 0 ? (
            <Empty title="Aucun paiement" />
          ) : (
            <div className="xs">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Reçu</th>
                    <th>Mode</th>
                    <th className="num">Montant (TND)</th>
                    <th>Statut</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id}>
                      <td>{frDateTime(p.receivedAt)}</td>
                      <td>{p.receiptId ? <Link to={`/recus/${p.receiptId}`}>{p.receiptNumber}</Link> : ""}</td>
                      <td>
                        {METHOD[p.method]}
                        {p.method === "cheque" ? (
                          <div className="cap">
                            n° {p.chequeNumber} · {CHEQUE[p.chequeStatus ?? "received"]}
                          </div>
                        ) : null}
                      </td>
                      <td className="num">{tnd(p.amount)}</td>
                      <td>
                        {p.status === "cancelled" ? (
                          <Badge tone="gray" strike>
                            Annulé
                          </Badge>
                        ) : p.kind === "refund" ? (
                          <Badge tone="violet">Remboursement</Badge>
                        ) : p.chequeStatus === "bounced" ? (
                          <Badge tone="red">Chèque impayé</Badge>
                        ) : (
                          <Badge tone="green">Valide</Badge>
                        )}
                        {p.cancelReason ? <div className="cap">{p.cancelReason}</div> : null}
                      </td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        {p.status === "valid" &&
                        p.method === "cheque" &&
                        p.kind === "payment" &&
                        can("payments:write") &&
                        (CHEQUE_NEXT[p.chequeStatus ?? "received"] ?? []).length ? (
                          <button type="button" className="btn btn-g" onClick={() => setCheque(p)}>
                            Statut du chèque
                          </button>
                        ) : null}
                        {p.status === "valid" && can("payments:cancel") ? (
                          <button type="button" className="btn btn-g" onClick={() => setCancelPayment(p)}>
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
      ) : null}

      {tab === "attendance" ? <AttendanceTab studentId={id} enrolments={enrolments.data ?? []} /> : null}

      {tab === "documents" ? (
        <Card title="Reçus">
          {payments.filter((p) => p.receiptId).length === 0 ? (
            <Empty title="Aucun reçu" />
          ) : (
            <div className="xs">
              <table className="tbl">
                <tbody>
                  {payments
                    .filter((p) => p.receiptId)
                    .map((p) => (
                      <tr key={p.id}>
                        <td>
                          <Link to={`/recus/${p.receiptId}`}>{p.receiptNumber}</Link>
                        </td>
                        <td>{frDate(p.receivedAt)}</td>
                        <td className="num">{tnd(p.amount)} TND</td>
                        <td style={{ textAlign: "right" }}>
                          <a className="btn btn-g" href={api.fileUrl(`/receipts/${p.receiptId}/view`)} target="_blank" rel="noreferrer">
                            Consulter
                          </a>
                          <a className="btn btn-g" href={api.fileUrl(`/receipts/${p.receiptId}/pdf`)} target="_blank" rel="noreferrer">
                            Imprimer
                          </a>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {tab === "history" ? (
        <Card title="Historique">
          <div className="card-b">
            {account.data?.timeline.length ? (
              <ol className="tl">
                {account.data.timeline.map((t, i) => (
                  <li key={i}>
                    <div className="cap">{frDateTime(t.at)}</div>
                    <div>{t.label}</div>
                    {t.detail ? <div className="cap">{t.detail}</div> : null}
                  </li>
                ))}
              </ol>
            ) : (
              <Empty title="Aucun événement" />
            )}
          </div>
        </Card>
      ) : null}

      {editing ? (
        <StudentFormModal
          initial={toForm(s)}
          studentId={id}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            toast("Fiche mise à jour.");
          }}
        />
      ) : null}
      {archiving ? (
        <ReasonDialog
          title={s.status === "archived" ? "Restaurer l'élève" : "Archiver l'élève"}
          explanation={
            s.status === "archived"
              ? "La fiche redevient active."
              : "La fiche est conservée avec tout son historique ; elle n'apparaît plus dans les listes actives."
          }
          confirmLabel={s.status === "archived" ? "Restaurer" : "Archiver"}
          onClose={() => setArchiving(false)}
          onConfirm={async (reason) => {
            await api.post(`/students/${id}/${s.status === "archived" ? "restore" : "archive"}`, { reason });
            await client.invalidateQueries();
            toast(s.status === "archived" ? "Élève restauré." : "Élève archivé.");
          }}
        />
      ) : null}
      {transfer ? <TransferModal enrolment={transfer} onClose={() => setTransfer(null)} /> : null}
      {drop ? (
        <ReasonDialog
          title="Déclarer un abandon"
          danger
          explanation={`${drop.groupName} : les échéances non payées dues après la date d'abandon sont annulées. Rien n'est remboursé automatiquement.`}
          extra={
            <Field label="Date d'abandon">
              <input className="input" type="date" value={dropDate} onChange={(e) => setDropDate(e.target.value)} />
            </Field>
          }
          confirmLabel="Confirmer l'abandon"
          onClose={() => setDrop(null)}
          onConfirm={async (reason) => {
            const r = await api.post<{ cancelledInstallments: number }>(`/enrolments/${drop.id}/drop`, { date: dropDate, reason });
            await client.invalidateQueries();
            toast(`Abandon enregistré. ${r.cancelledInstallments} échéance(s) annulée(s).`);
          }}
        />
      ) : null}
      {postpone ? <PostponeModal installment={postpone} onClose={() => setPostpone(null)} /> : null}
      {cheque ? <ChequeModal payment={cheque} onClose={() => setCheque(null)} /> : null}
      {cancelPayment ? (
        <ReasonDialog
          title="Annuler le paiement"
          danger
          explanation={`Le paiement de ${tnd(cancelPayment.amount)} TND${cancelPayment.receiptNumber ? ` (reçu ${cancelPayment.receiptNumber})` : ""} est annulé par un reçu d'annulation. Le reçu d'origine reste archivé.`}
          confirmLabel="Annuler le paiement"
          onClose={() => setCancelPayment(null)}
          onConfirm={async (reason) => {
            const r = await api.post<{ cancellationReceipt: { id: string; number: string } }>(`/payments/${cancelPayment.id}/cancel`, { reason });
            await client.invalidateQueries();
            toast(`Paiement annulé. Reçu d'annulation ${r.cancellationReceipt.number}.`);
          }}
        />
      ) : null}
      {refund && totals ? <RefundModal studentId={id} credit={totals.credit} onClose={() => setRefund(false)} /> : null}
      {rejectDiscount ? (
        <ReasonDialog
          title="Refuser la remise"
          explanation={`${rejectDiscount.label} : ${tnd(rejectDiscount.amount)} TND.`}
          confirmLabel="Refuser"
          danger
          onClose={() => setRejectDiscount(null)}
          onConfirm={async (reason) => {
            await api.post(`/enrolments/discounts/${rejectDiscount.id}/decision`, { approve: false, reason });
            await client.invalidateQueries();
            toast("Remise refusée.");
          }}
        />
      ) : null}
    </>
  );
}
