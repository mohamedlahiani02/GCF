import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../api/client";
import { useSession } from "../auth/session";
import { usePage } from "../components/shell";
import { useToast } from "../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Kpi, Loading, Modal, PageHeader, Pagination, ReasonDialog, Segmented, StateBadge } from "../components/ui";
import { frDate, frDateTime, tnd, todayIso } from "../lib/format";
import type { Tone } from "../lib/labels";

export type PayerKind = "student" | "renter" | "member";
export interface PayerRef {
  kind: PayerKind;
  id: string;
}

type InvoiceState = "credited" | "paid" | "partial" | "overdue" | "unpaid" | "credit_note";
type ListFilter = "all" | "unpaid" | "overdue" | "paid" | "unsent" | "credited" | "credit_note";

interface InvoiceRow {
  id: string;
  kind: "invoice" | "credit_note";
  number: string;
  issueDate: string;
  dueDate: string | null;
  total: number;
  status: "issued" | "credited";
  sentAt: string | null;
  sentTo: string | null;
  buyerName: string;
  paid: number;
  remaining: number;
  state: InvoiceState;
}

interface InvoiceDetail extends InvoiceRow {
  net: number;
  tax: number;
  taxBp: number | null;
  creditReason: string | null;
  creditsInvoiceId: string | null;
  sentBy: string | null;
  studentId: string | null;
  renterId: string | null;
  memberId: string | null;
  sha256: string;
  snapshot: {
    buyer: { name: string; company: boolean; taxId: string | null; address: string | null; email: string | null };
    lines: { label: string; amount: number }[];
    credits: { number: string; issueDate: string; reason: string } | null;
  };
  creditNote: { id: string; number: string } | null;
  dispatches: { sentAt: string; recipient: string; status: "sent" | "failed"; error: string | null }[];
}

interface Charge {
  id: string;
  label: string;
  amount: number;
  dueDate: string;
  paid: number;
  remaining: number;
  state: string;
}

const STATE: Record<InvoiceState, { label: string; tone: Tone }> = {
  unpaid: { label: "À payer", tone: "amber" },
  partial: { label: "Payée en partie", tone: "blue" },
  overdue: { label: "En retard", tone: "red" },
  paid: { label: "Payée", tone: "green" },
  credited: { label: "Annulée par avoir", tone: "gray" },
  credit_note: { label: "Avoir", tone: "violet" },
};

const FILTERS: { value: ListFilter; label: string }[] = [
  { value: "all", label: "Toutes" },
  { value: "unpaid", label: "À payer" },
  { value: "overdue", label: "En retard" },
  { value: "paid", label: "Payées" },
  { value: "unsent", label: "Non envoyées" },
  { value: "credit_note", label: "Avoirs" },
];

/** The client's page; renters have none. */
const payerLink = (r: { studentId: string | null; memberId: string | null }) =>
  r.studentId ? `/eleves/${r.studentId}` : r.memberId ? `/coworking/membres/${r.memberId}` : null;

export function InvoicesPage() {
  usePage(["Finances", "Factures"]);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filter = (params.get("etat") as ListFilter | null) ?? "all";
  const payerKind = params.get("payeur") as PayerKind | null;
  const payerId = params.get("id");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ["invoices", filter, q, page, payerKind, payerId],
    queryFn: () =>
      api.get<{ items: InvoiceRow[]; hasMore: boolean; totals: { invoiced: number; remaining: number } }>("/invoices", {
        state: filter,
        q,
        page,
        pageSize: 50,
        ...(payerKind && payerId ? { payerKind, payerId } : {}),
      }),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader
        title="Factures et avoirs"
        subtitle="Une facture reprend des montants déjà dus. Elle est numérotée sans trou et ne se modifie pas : une erreur se corrige par un avoir."
        actions={
          payerKind ? (
            <button type="button" className="btn btn-g" onClick={() => setParams({ etat: filter })}>
              Voir toutes les factures
            </button>
          ) : null
        }
      />
      {list.data ? (
        <div className="grid4">
          <Kpi label="Facturé (sélection)" value={<span className="num">{tnd(list.data.totals.invoiced)}</span>} sub="TND TTC, hors factures annulées" />
          <Kpi
            label="Reste à encaisser"
            value={<span className="num">{tnd(list.data.totals.remaining)}</span>}
            sub="TND"
            tone={list.data.totals.remaining > 0 ? "amber" : undefined}
          />
        </div>
      ) : null}
      <div className="row center" style={{ gap: 12, flexWrap: "wrap" }}>
        <Segmented label="État" value={filter} onChange={(v) => (setParams({ ...Object.fromEntries(params), etat: v }), setPage(1))} options={FILTERS} />
        <input
          className="input"
          style={{ width: 260 }}
          placeholder="Numéro ou client"
          aria-label="Rechercher une facture"
          value={q}
          onChange={(e) => (setQ(e.target.value), setPage(1))}
        />
      </div>
      <Card footer={list.data ? <Pagination page={page} hasMore={list.data.hasMore} onPage={setPage} /> : null}>
        <ErrorBanner error={list.error} retry={() => list.refetch()} />
        {list.isPending ? (
          <Loading />
        ) : list.data?.items.length === 0 ? (
          <Empty title="Aucune facture" text="Facturez depuis la fiche d'un client : bouton « Facturer »." />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Numéro</th>
                  <th>Date</th>
                  <th>Client</th>
                  <th>Échéance</th>
                  <th className="num">Montant TTC</th>
                  <th className="num">Reste</th>
                  <th>État</th>
                  <th>Envoi</th>
                </tr>
              </thead>
              <tbody>
                {list.data?.items.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => navigate(`/factures/${r.id}`)}>
                    <td>
                      <Link to={`/factures/${r.id}`} onClick={(e) => e.stopPropagation()}>
                        {r.number}
                      </Link>
                    </td>
                    <td>{frDate(r.issueDate)}</td>
                    <td>{r.buyerName}</td>
                    <td>{r.dueDate ? frDate(r.dueDate) : ""}</td>
                    <td className="num">{tnd(r.total)}</td>
                    <td className="num">{r.kind === "invoice" && r.status === "issued" ? tnd(r.remaining) : ""}</td>
                    <td>
                      <Badge tone={STATE[r.state].tone} strike={r.state === "credited"}>
                        {STATE[r.state].label}
                      </Badge>
                    </td>
                    <td>{r.sentAt ? <Badge tone="green">Envoyée</Badge> : <Badge tone="neutral">Non envoyée</Badge>}</td>
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

export function InvoicePage() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const toast = useToast();
  const client = useQueryClient();
  const [dialog, setDialog] = useState<"send" | "delivered" | "credit" | null>(null);
  const [to, setTo] = useState("");
  const [how, setHow] = useState("Remise en main propre à l'accueil");
  const invoice = useQuery({ queryKey: ["invoice", id], queryFn: () => api.get<InvoiceDetail>(`/invoices/${id}`) });
  usePage(["Finances", "Factures", invoice.data?.number ?? "Facture"]);
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ["invoice", id] }), client.invalidateQueries({ queryKey: ["invoices"] })]);
  const send = useMutation({
    mutationFn: () => api.post<{ status: "sent" | "failed" }>(`/invoices/${id}/send`, { to: to.trim() }),
    onSuccess: async (r) => {
      await refresh();
      toast(r.status === "sent" ? `Envoyée à ${to.trim()}.` : "L'envoi a échoué ; il est noté au journal d'envoi.", r.status === "sent" ? "success" : "error");
      setDialog(null);
    },
  });
  const delivered = useMutation({
    mutationFn: () => api.post(`/invoices/${id}/delivered`, { how: how.trim() }),
    onSuccess: async () => {
      await refresh();
      toast("Remise enregistrée.");
      setDialog(null);
    },
  });
  if (invoice.isPending) return <Loading />;
  if (invoice.error) return <ErrorBanner error={invoice.error} retry={() => invoice.refetch()} />;
  const v = invoice.data;
  const s = v.snapshot;
  const link = payerLink(v);
  const title = `${v.kind === "invoice" ? "Facture" : "Avoir"} ${v.number}`;
  return (
    <>
      <PageHeader
        title={title}
        subtitle={
          <span className="row center" style={{ gap: 8 }}>
            <Badge tone={STATE[v.state].tone}>{STATE[v.state].label}</Badge>
            <span>
              Émise le {frDate(v.issueDate)}
              {v.dueDate ? `, échéance le ${frDate(v.dueDate)}` : ""}
            </span>
            {link ? <Link to={link}>{s.buyer.name}</Link> : <span>{s.buyer.name}</span>}
          </span>
        }
        actions={
          <>
            <a className="btn btn-p" href={api.fileUrl(`/invoices/${id}/pdf`)} target="_blank" rel="noreferrer">
              Ouvrir le PDF
            </a>
            {can("invoices:write") ? (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setTo(s.buyer.email ?? "");
                    setDialog("send");
                  }}
                >
                  Envoyer par e-mail
                </button>
                {v.sentAt ? null : (
                  <button type="button" className="btn btn-g" onClick={() => setDialog("delivered")}>
                    Marquer comme remise
                  </button>
                )}
              </>
            ) : null}
            {can("invoices:cancel") && v.kind === "invoice" && v.status === "issued" ? (
              <button type="button" className="btn btn-g" onClick={() => setDialog("credit")}>
                Annuler par un avoir
              </button>
            ) : null}
          </>
        }
      />
      {v.kind === "invoice" ? (
        <div className="grid4">
          <Kpi
            label="Montant TTC"
            value={<span className="num">{tnd(v.total)}</span>}
            sub={v.taxBp ? `TND, dont ${tnd(v.net)} HT et ${tnd(v.tax)} de taxe` : "TND"}
          />
          <Kpi label="Payé" value={<span className="num">{tnd(v.paid)}</span>} sub="TND, selon les encaissements" />
          <Kpi label="Reste à payer" value={<span className="num">{tnd(v.remaining)}</span>} sub="TND" tone={v.state === "overdue" ? "red" : undefined} />
          <Kpi
            label="Envoi"
            value={v.sentAt ? "Envoyée" : "Non envoyée"}
            sub={v.sentAt ? `${frDateTime(v.sentAt)}, ${v.sentTo ?? ""}` : "ni envoyée ni remise"}
          />
        </div>
      ) : null}
      {v.creditNote ? (
        <div className="ban ban-amber">
          <span>
            Annulée par l'avoir <Link to={`/factures/${v.creditNote.id}`}>{v.creditNote.number}</Link> : {v.creditReason}. Les montants qu'elle reprenait
            peuvent être facturés à nouveau.
          </span>
        </div>
      ) : null}
      {s.credits && v.creditsInvoiceId ? (
        <div className="ban ban-amber">
          <span>
            Annule la facture <Link to={`/factures/${v.creditsInvoiceId}`}>{s.credits.number}</Link> du {s.credits.issueDate} : {s.credits.reason}
          </span>
        </div>
      ) : null}
      <div className="grid2" style={{ gridTemplateColumns: "3fr 2fr", alignItems: "start" }}>
        <Card title="Document archivé">
          <iframe title={title} src={api.fileUrl(`/invoices/${id}/pdf`)} style={{ width: "100%", height: 720, border: 0, display: "block" }} />
        </Card>
        <div className="stack">
          <Card title="Client">
            <div className="card-b stack" style={{ gap: 4 }}>
              <strong>{s.buyer.name}</strong>
              {s.buyer.address ? <span>{s.buyer.address}</span> : null}
              {s.buyer.taxId ? <span>Matricule fiscal : {s.buyer.taxId}</span> : null}
              {s.buyer.email ? <span className="cap">{s.buyer.email}</span> : null}
            </div>
          </Card>
          <Card title="Lignes">
            <div className="xs">
              <table className="tbl">
                <tbody>
                  {s.lines.map((l, i) => (
                    <tr key={i}>
                      <td>{l.label}</td>
                      <td className="num">{tnd(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Total TTC</td>
                    <td className="num">{tnd(v.total)} TND</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
          <Card title="Envois">
            <div className="card-b stack">
              {v.dispatches.length === 0 && !v.sentAt ? <span className="cap">Jamais envoyée.</span> : null}
              {v.dispatches.map((d, i) => (
                <div key={i}>
                  {frDateTime(d.sentAt)} · {d.recipient} ·{" "}
                  <Badge tone={d.status === "sent" ? "green" : "red"}>{d.status === "sent" ? "Envoyée" : "Échec"}</Badge>
                  {d.error ? <div className="cap">{d.error}</div> : null}
                </div>
              ))}
              {v.sentAt && v.dispatches.every((d) => d.status !== "sent") ? (
                <div>
                  {frDateTime(v.sentAt)} · {v.sentTo}
                  {v.sentBy ? ` · ${v.sentBy}` : ""}
                </div>
              ) : null}
              <div className="cap" style={{ wordBreak: "break-all" }}>
                Empreinte SHA-256 : {v.sha256}
              </div>
            </div>
          </Card>
        </div>
      </div>
      {dialog === "send" ? (
        <Modal
          title="Envoyer par e-mail"
          onClose={() => setDialog(null)}
          footer={
            <>
              <span />
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn" onClick={() => setDialog(null)}>
                  Annuler
                </button>
                <button type="button" className="btn btn-p" disabled={!to.trim() || send.isPending} onClick={() => send.mutate()}>
                  Envoyer
                </button>
              </div>
            </>
          }
        >
          <Field label="Destinataire" hint="Le PDF archivé est joint au message.">
            <input className="input" type="email" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <ErrorBanner error={send.error} />
        </Modal>
      ) : null}
      {dialog === "delivered" ? (
        <Modal
          title="Marquer comme remise"
          onClose={() => setDialog(null)}
          footer={
            <>
              <span />
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn" onClick={() => setDialog(null)}>
                  Annuler
                </button>
                <button type="button" className="btn btn-p" disabled={!how.trim() || delivered.isPending} onClick={() => delivered.mutate()}>
                  Enregistrer
                </button>
              </div>
            </>
          }
        >
          <Field label="Comment la facture a été remise">
            <input className="input" value={how} maxLength={120} onChange={(e) => setHow(e.target.value)} />
          </Field>
          <ErrorBanner error={delivered.error} />
        </Modal>
      ) : null}
      {dialog === "credit" ? (
        <ReasonDialog
          title="Annuler la facture par un avoir"
          explanation={`Un avoir de ${tnd(-v.total)} TND est émis et numéroté. La facture ${v.number} reste archivée, marquée comme annulée ; les montants qu'elle reprenait pourront être facturés à nouveau. Les paiements déjà reçus ne changent pas.`}
          confirmLabel="Émettre l'avoir"
          danger
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => {
            const created = await api.post<{ id: string; number: string }>(`/invoices/${id}/credit`, { reason });
            await refresh();
            toast(`Avoir ${created.number} émis.`);
          }}
        />
      ) : null}
    </>
  );
}

/** "Facturer" on a client's page: choose among the open charges that no standing invoice lists yet. */
export function IssueInvoiceButton({ payer }: { payer: PayerRef }) {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  if (!can("invoices:write")) return null;
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        Facturer
      </button>
      {open ? <IssueInvoiceModal payer={payer} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function IssueInvoiceModal({ payer, onClose }: { payer: PayerRef; onClose: () => void }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const toast = useToast();
  const charges = useQuery({
    queryKey: ["uninvoiced", payer.kind, payer.id],
    queryFn: () => api.get<Charge[]>("/invoices/uninvoiced", { payerKind: payer.kind, payerId: payer.id }),
  });
  const [picked, setPicked] = useState<Set<string> | null>(null);
  // By default, what falls due by the end of this month; later instalments are invoiced when they come.
  const monthEnd = `${todayIso().slice(0, 7)}-31`;
  const selection = picked ?? new Set((charges.data ?? []).filter((c) => c.dueDate <= monthEnd).map((c) => c.id));
  const total = (charges.data ?? []).filter((c) => selection.has(c.id)).reduce((sum, c) => sum + c.amount, 0);
  const toggle = (chargeId: string) => {
    const next = new Set(selection);
    if (next.has(chargeId)) next.delete(chargeId);
    else next.add(chargeId);
    setPicked(next);
  };
  const issue = useMutation({
    mutationFn: () => api.post<{ id: string; number: string }>("/invoices", { payer, installmentIds: [...selection] }),
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: ["invoices"] });
      await client.invalidateQueries({ queryKey: ["uninvoiced"] });
      toast(`Facture ${created.number} émise.`);
      navigate(`/factures/${created.id}`);
    },
  });
  return (
    <Modal
      title="Nouvelle facture"
      onClose={onClose}
      footer={
        <>
          <span className="cap">
            {selection.size} ligne(s) · {tnd(total)} TND TTC
          </span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={selection.size === 0 || issue.isPending} onClick={() => issue.mutate()}>
              Émettre la facture
            </button>
          </div>
        </>
      }
    >
      <p className="cap">La facture reprend des montants déjà dus. Une fois émise, elle ne se modifie plus : une erreur se corrige par un avoir.</p>
      <ErrorBanner error={charges.error ?? issue.error} retry={() => charges.refetch()} />
      {charges.isPending ? (
        <Loading />
      ) : charges.data?.length === 0 ? (
        <Empty title="Rien à facturer" text="Tous les montants dus de ce client sont déjà sur une facture." />
      ) : (
        <div className="xs">
          <table className="tbl">
            <thead>
              <tr>
                <th />
                <th>Montant dû</th>
                <th>Échéance</th>
                <th>État</th>
                <th className="num">Montant</th>
              </tr>
            </thead>
            <tbody>
              {charges.data?.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => toggle(c.id)}>
                  <td>
                    <input
                      type="checkbox"
                      className="chk"
                      aria-label={c.label}
                      checked={selection.has(c.id)}
                      onChange={() => toggle(c.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </td>
                  <td>{c.label}</td>
                  <td>{frDate(c.dueDate)}</td>
                  <td>
                    <StateBadge state={c.state} />
                  </td>
                  <td className="num">{tnd(c.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
