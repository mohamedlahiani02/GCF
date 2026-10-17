import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import { useSession } from "../auth/session";
import { usePage, useCollect } from "../components/shell";
import { useToast } from "../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Loading, PageHeader, Pagination, ReasonDialog, Tabs } from "../components/ui";
import { errorMessage } from "../lib/errors";
import { frDate, frDateTime, tnd, todayIso } from "../lib/format";
import { CHEQUE, METHOD } from "../lib/labels";

interface PaymentListRow {
  id: string;
  kind: "payment" | "refund";
  receivedAt: string;
  studentId: string | null;
  renterId: string | null;
  firstName: string | null;
  lastName: string | null;
  renterName: string | null;
  memberId: string | null;
  memberName: string | null;
  amount: number;
  method: string;
  chequeStatus: string | null;
  status: "valid" | "cancelled";
  receiptId: string | null;
  receiptNumber: string | null;
  createdBy: string | null;
}
interface ReminderRow {
  studentId: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  recipient: string | null;
  total: number;
  items: { installmentId: string; label: string; dueDate: string; remaining: number }[];
}
interface Approvals {
  discounts: { id: string; label: string; amount: number; createdAt: string; studentId: string; studentName: string; requestedBy: string | null }[];
  postponements: {
    id: string;
    label: string;
    fromDate: string;
    toDate: string;
    reason: string;
    requestedAt: string;
    studentId: string | null;
    studentName: string | null;
    requestedBy: string | null;
  }[];
}

type Tab = "journal" | "reminders" | "approvals";

function Journal() {
  const [from, setFrom] = useState(todayIso().slice(0, 8) + "01");
  const [to, setTo] = useState(todayIso());
  const [method, setMethod] = useState("");
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ["payments", from, to, method, page],
    queryFn: () => api.get<{ items: PaymentListRow[]; hasMore: boolean }>("/payments", { from, to, method, page, pageSize: 50 }),
    placeholderData: keepPreviousData,
  });
  return (
    <Card
      title={
        <div className="row center" style={{ gap: 8 }}>
          <input className="input" type="date" aria-label="Du" value={from} onChange={(e) => (setFrom(e.target.value), setPage(1))} />
          <input className="input" type="date" aria-label="Au" value={to} onChange={(e) => (setTo(e.target.value), setPage(1))} />
          <select className="input" aria-label="Mode" value={method} onChange={(e) => (setMethod(e.target.value), setPage(1))}>
            <option value="">Tous les modes</option>
            {Object.entries(METHOD).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
      }
      footer={list.data ? <Pagination page={page} hasMore={list.data.hasMore} onPage={setPage} /> : null}
    >
      <ErrorBanner error={list.error} retry={() => list.refetch()} />
      {list.isPending ? (
        <Loading />
      ) : list.data?.items.length === 0 ? (
        <Empty title="Aucun paiement sur la période" />
      ) : (
        <div className="xs">
          <table className="tbl">
            <thead>
              <tr>
                <th>Date</th>
                <th>Payeur</th>
                <th>Reçu</th>
                <th>Mode</th>
                <th className="num">Montant (TND)</th>
                <th>Statut</th>
                <th>Saisi par</th>
              </tr>
            </thead>
            <tbody>
              {list.data?.items.map((p) => (
                <tr key={p.id}>
                  <td>{frDateTime(p.receivedAt)}</td>
                  <td>
                    {p.studentId ? (
                      <Link to={`/eleves/${p.studentId}`}>{`${p.lastName} ${p.firstName}`}</Link>
                    ) : p.memberId ? (
                      <Link to={`/coworking/membres/${p.memberId}`}>{p.memberName}</Link>
                    ) : (
                      p.renterName
                    )}
                  </td>
                  <td>{p.receiptId ? <Link to={`/recus/${p.receiptId}`}>{p.receiptNumber}</Link> : ""}</td>
                  <td>
                    {METHOD[p.method] ?? p.method}
                    {p.method === "cheque" ? <div className="cap">{CHEQUE[p.chequeStatus ?? "received"]}</div> : null}
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
                  </td>
                  <td>{p.createdBy ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Reminders() {
  const { can } = useSession();
  const toast = useToast();
  const [selected, setSelected] = useState<string[]>([]);
  const list = useQuery({ queryKey: ["reminders"], queryFn: () => api.get<ReminderRow[]>("/reminders") });
  const send = useMutation({
    mutationFn: () => api.post<{ results: { studentId: string; status: string }[] }>("/reminders/send", { studentIds: selected }),
    onSuccess: (r) => {
      const sent = r.results.filter((x) => x.status === "sent").length;
      const noRecipient = r.results.filter((x) => x.status === "no_recipient").length;
      const failed = r.results.filter((x) => x.status === "failed").length;
      toast(
        `${sent} relance(s) envoyée(s)${noRecipient ? `, ${noRecipient} sans adresse e-mail` : ""}${failed ? `, ${failed} en échec` : ""}.`,
        failed ? "error" : "success",
      );
      setSelected([]);
    },
    onError: (error) => toast(errorMessage(error), "error"),
  });
  const rows = list.data ?? [];
  return (
    <Card
      title="Échéances en retard"
      actions={
        can("reminders:send") ? (
          <button type="button" className="btn btn-p" disabled={!selected.length || send.isPending} onClick={() => send.mutate()}>
            Envoyer la relance ({selected.length})
          </button>
        ) : null
      }
    >
      <ErrorBanner error={list.error} retry={() => list.refetch()} />
      {list.isPending ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty title="Aucun retard" text="Aucune échéance n'a dépassé le délai de grâce." />
      ) : (
        <div className="xs">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    className="chk"
                    aria-label="Tout sélectionner"
                    checked={selected.length === rows.length}
                    onChange={(e) => setSelected(e.target.checked ? rows.map((r) => r.studentId) : [])}
                  />
                </th>
                <th>Élève</th>
                <th>Échéances</th>
                <th>Contact</th>
                <th className="num">Total dû (TND)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.studentId}>
                  <td>
                    <input
                      type="checkbox"
                      className="chk"
                      aria-label={`${r.lastName} ${r.firstName}`}
                      checked={selected.includes(r.studentId)}
                      onChange={(e) => setSelected((list) => (e.target.checked ? [...list, r.studentId] : list.filter((x) => x !== r.studentId)))}
                    />
                  </td>
                  <td>
                    <Link to={`/eleves/${r.studentId}`}>
                      {r.lastName} {r.firstName}
                    </Link>
                  </td>
                  <td>
                    {r.items.map((i) => (
                      <div key={i.installmentId} className="cap">
                        {i.label}, échue le {frDate(i.dueDate)} : {tnd(i.remaining)}
                      </div>
                    ))}
                  </td>
                  <td>
                    {r.recipient ?? <Badge tone="amber">Pas d'e-mail</Badge>}
                    {r.phone ? <div className="cap">{r.phone}</div> : null}
                  </td>
                  <td className="num">{tnd(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ApprovalsList() {
  const { can } = useSession();
  const toast = useToast();
  const client = useQueryClient();
  const [reject, setReject] = useState<{ kind: "discount" | "postponement"; id: string; label: string } | null>(null);
  const list = useQuery({ queryKey: ["approvals"], queryFn: () => api.get<Approvals>("/approvals") });
  const decide = useMutation({
    mutationFn: (input: { kind: "discount" | "postponement"; id: string }) =>
      api.post(input.kind === "discount" ? `/enrolments/discounts/${input.id}/decision` : `/postponements/${input.id}/decision`, { approve: true }),
    onSuccess: async () => {
      await client.invalidateQueries();
      toast("Demande approuvée.");
    },
    onError: (error) => toast(errorMessage(error), "error"),
  });
  if (list.isPending) return <Loading />;
  if (list.error) return <ErrorBanner error={list.error} retry={() => list.refetch()} />;
  const { discounts, postponements } = list.data;
  return (
    <>
      <Card title={`Remises à valider (${discounts.length})`}>
        {discounts.length === 0 ? (
          <Empty title="Aucune remise en attente" />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Élève</th>
                  <th>Remise</th>
                  <th className="num">Montant (TND)</th>
                  <th>Demandée</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {discounts.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <Link to={`/eleves/${d.studentId}`}>{d.studentName}</Link>
                    </td>
                    <td>{d.label}</td>
                    <td className="num">{tnd(d.amount)}</td>
                    <td>
                      {frDateTime(d.createdAt)}
                      <div className="cap">{d.requestedBy}</div>
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {can("discounts:approve") ? (
                        <>
                          <button type="button" className="btn btn-g" disabled={decide.isPending} onClick={() => decide.mutate({ kind: "discount", id: d.id })}>
                            Approuver
                          </button>
                          <button type="button" className="btn btn-g" onClick={() => setReject({ kind: "discount", id: d.id, label: d.label })}>
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
      </Card>
      <Card title={`Reports à valider (${postponements.length})`}>
        {postponements.length === 0 ? (
          <Empty title="Aucun report en attente" />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Payeur</th>
                  <th>Échéance</th>
                  <th>Report</th>
                  <th>Motif</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {postponements.map((p) => (
                  <tr key={p.id}>
                    <td>{p.studentId ? <Link to={`/eleves/${p.studentId}`}>{p.studentName}</Link> : "Location"}</td>
                    <td>{p.label}</td>
                    <td>
                      {frDate(p.fromDate)} → {frDate(p.toDate)}
                    </td>
                    <td>
                      {p.reason}
                      <div className="cap">
                        {p.requestedBy} · {frDateTime(p.requestedAt)}
                      </div>
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {can("postponements:approve") ? (
                        <>
                          <button
                            type="button"
                            className="btn btn-g"
                            disabled={decide.isPending}
                            onClick={() => decide.mutate({ kind: "postponement", id: p.id })}
                          >
                            Approuver
                          </button>
                          <button type="button" className="btn btn-g" onClick={() => setReject({ kind: "postponement", id: p.id, label: p.label })}>
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
      </Card>
      {reject ? (
        <ReasonDialog
          title={reject.kind === "discount" ? "Refuser la remise" : "Refuser le report"}
          explanation={reject.label}
          confirmLabel="Refuser"
          danger
          onClose={() => setReject(null)}
          onConfirm={async (reason) => {
            await api.post(reject.kind === "discount" ? `/enrolments/discounts/${reject.id}/decision` : `/postponements/${reject.id}/decision`, {
              approve: false,
              reason,
            });
            await client.invalidateQueries();
            toast("Demande refusée.");
          }}
        />
      ) : null}
    </>
  );
}

export function PaymentsPage() {
  usePage(["Encaissements"]);
  const { can } = useSession();
  const collect = useCollect();
  const [tab, setTab] = useState<Tab>("journal");
  return (
    <>
      <PageHeader
        title="Encaissements"
        actions={
          can("payments:write") ? (
            <button type="button" className="btn btn-p" onClick={() => collect()}>
              + Encaisser
            </button>
          ) : null
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "journal", label: "Paiements" },
          { value: "reminders", label: "Relances" },
          { value: "approvals", label: "Validations" },
        ]}
      />
      {tab === "journal" ? <Journal /> : tab === "reminders" ? <Reminders /> : <ApprovalsList />}
    </>
  );
}
