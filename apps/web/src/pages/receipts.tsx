import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../api/client";
import { useSession } from "../auth/session";
import { ActivityFilter, FINANCIAL_ACTIVITY, type FinancialActivity } from "../components/activity-filter";
import { usePage } from "../components/shell";
import { useToast } from "../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, PageHeader, Pagination } from "../components/ui";
import { frDateTime, tnd, todayIso } from "../lib/format";
import { METHOD } from "../lib/labels";

interface ReceiptRow {
  id: string;
  number: string;
  kind: "payment" | "refund" | "cancellation";
  issuedAt: string;
  firstName: string | null;
  lastName: string | null;
  renterName: string | null;
  payerName: string;
  activities: FinancialActivity[];
  amount: number;
  status: "valid" | "cancelled" | "cancellation";
  dispatch: "sent" | "failed" | "not_sent";
}

interface ReceiptDetail {
  id: string;
  number: string;
  kind: ReceiptRow["kind"];
  issuedAt: string;
  paymentId: string;
  cancelsReceiptId: string | null;
  sha256: string;
  snapshot: {
    payer: { name: string; guardianName: string | null };
    method: string;
    chequeNumber: string | null;
    chequeBank: string | null;
    reference: string | null;
    amount: number;
    lines: { label: string; amount: number }[];
    creditAfter: number;
    remainingAfter: number;
    cancels: { number: string; reason: string } | null;
  };
  cancelledBy: { id: string; number: string } | null;
  prints: { printedAt: string; duplicate: boolean; printedBy: string | null }[];
  dispatches: { sentAt: string; recipient: string; status: string; error: string | null }[];
}

const KIND: Record<ReceiptRow["kind"], string> = { payment: "Paiement", refund: "Remboursement", cancellation: "Annulation" };
const STATUS: Record<ReceiptRow["status"], { label: string; tone: "green" | "gray" | "red" }> = {
  valid: { label: "Valide", tone: "green" },
  cancelled: { label: "Annulé", tone: "gray" },
  cancellation: { label: "Reçu d'annulation", tone: "red" },
};
const DISPATCH: Record<ReceiptRow["dispatch"], { label: string; tone: "green" | "red" | "neutral" }> = {
  sent: { label: "Envoyé", tone: "green" },
  failed: { label: "Échec d'envoi", tone: "red" },
  not_sent: { label: "Non envoyé", tone: "neutral" },
};
const RECEIPT_MONTHS = Array.from({ length: 12 }, (_, index) => ({
  value: String(index + 1).padStart(2, "0"),
  label: new Intl.DateTimeFormat("fr-FR", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2000, index, 1))),
}));

export function ReceiptsPage() {
  usePage(["Reçus"]);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const deferredQuery = useDeferredValue(q);
  const activity = (Object.keys(FINANCIAL_ACTIVITY) as FinancialActivity[]).find((value) => value === params.get("activite")) ?? "";
  const kind = (Object.keys(KIND) as ReceiptRow["kind"][]).find((value) => value === params.get("type")) ?? "";
  const status = (Object.keys(STATUS) as ReceiptRow["status"][]).find((value) => value === params.get("statut")) ?? "";
  const dispatch = (Object.keys(DISPATCH) as ReceiptRow["dispatch"][]).find((value) => value === params.get("envoi")) ?? "";
  const year = params.get("annee") ?? "";
  const month = RECEIPT_MONTHS.find((value) => value.value === params.get("mois"))?.value ?? "";
  const validYear = /^\d{4}$/.test(year) && Number(year) >= 1900;
  const from = validYear ? `${year}-${month || "01"}-01` : undefined;
  const lastDay = validYear ? new Date(Date.UTC(Number(year), Number(month || "12"), 0)).getUTCDate() : undefined;
  const to = validYear ? `${year}-${month || "12"}-${String(lastDay).padStart(2, "0")}` : undefined;
  const requestedPage = Number(params.get("page"));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const setFilter = (name: string, value: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(name, value);
        else next.delete(name);
        if (name === "annee" && !value) next.delete("mois");
        if (name === "mois" && value && !next.get("annee")) next.set("annee", todayIso().slice(0, 4));
        next.delete("page");
        return next;
      },
      { replace: true },
    );
  const setPage = (value: number) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value > 1) next.set("page", String(value));
      else next.delete("page");
      return next;
    });
  const list = useQuery({
    queryKey: ["receipts", deferredQuery, activity, kind, status, dispatch, from, to, page],
    queryFn: () =>
      api.get<{ items: ReceiptRow[]; hasMore: boolean }>("/receipts", { q: deferredQuery, activity, kind, status, dispatch, from, to, page, pageSize: 50 }),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader
        title="Archive des reçus"
        subtitle="Les reçus sont numérotés sans trou, archivés et non modifiables. Une erreur se corrige par un reçu d'annulation."
      />
      <Card
        title={
          <div className="row" style={{ gap: 12, alignItems: "end", width: "100%" }}>
            <div style={{ flex: "1 1 220px" }}>
              <Field label="Payeur ou numéro de reçu">
                <input
                  className="input"
                  style={{ width: "100%" }}
                  type="search"
                  placeholder="Nom du payeur ou REC-…"
                  value={q}
                  onChange={(event) => setFilter("q", event.target.value)}
                />
              </Field>
            </div>
            <ActivityFilter value={activity} onChange={(value) => setFilter("activite", value)} />
            <Field label="Type de reçu">
              <select className="input" value={kind} onChange={(event) => setFilter("type", event.target.value)}>
                <option value="">Tous les types</option>
                {Object.entries(KIND).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Année">
              <input
                className="input"
                type="number"
                min="1900"
                max="9999"
                step="1"
                style={{ width: 100 }}
                placeholder="Toutes"
                value={year}
                onChange={(event) => setFilter("annee", event.target.value)}
              />
            </Field>
            <Field label="Mois">
              <select className="input" value={month} onChange={(event) => setFilter("mois", event.target.value)}>
                <option value="">Tous les mois</option>
                {RECEIPT_MONTHS.map((value) => (
                  <option key={value.value} value={value.value}>
                    {value.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Statut">
              <select className="input" value={status} onChange={(event) => setFilter("statut", event.target.value)}>
                <option value="">Tous les statuts</option>
                {Object.entries(STATUS).map(([value, item]) => (
                  <option key={value} value={value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Envoi">
              <select className="input" value={dispatch} onChange={(event) => setFilter("envoi", event.target.value)}>
                <option value="">Tous les envois</option>
                {Object.entries(DISPATCH).map(([value, item]) => (
                  <option key={value} value={value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </Field>
            {q || activity || kind || year || month || status || dispatch ? (
              <button className="btn" type="button" onClick={() => setParams({})}>
                Réinitialiser
              </button>
            ) : null}
          </div>
        }
        footer={list.data ? <Pagination page={page} hasMore={list.data.hasMore} onPage={setPage} /> : null}
      >
        <ErrorBanner error={list.error} retry={() => list.refetch()} />
        {list.isPending ? (
          <Loading />
        ) : list.data?.items.length === 0 ? (
          <Empty title="Aucun reçu" />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Numéro</th>
                  <th>Date</th>
                  <th>Payeur</th>
                  <th>Activité</th>
                  <th>Type</th>
                  <th className="num">Montant (TND)</th>
                  <th>Statut</th>
                  <th>Envoi</th>
                </tr>
              </thead>
              <tbody>
                {list.data?.items.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => navigate(`/recus/${r.id}`)}>
                    <td>
                      <Link to={`/recus/${r.id}`} onClick={(e) => e.stopPropagation()}>
                        {r.number}
                      </Link>
                    </td>
                    <td>{frDateTime(r.issuedAt)}</td>
                    <td>{r.payerName}</td>
                    <td>{r.activities.length ? r.activities.map((value) => FINANCIAL_ACTIVITY[value]).join(" · ") : "Sans affectation"}</td>
                    <td>{KIND[r.kind]}</td>
                    <td className="num">{tnd(r.amount)}</td>
                    <td>
                      <Badge tone={STATUS[r.status].tone} strike={r.status === "cancelled"}>
                        {STATUS[r.status].label}
                      </Badge>
                    </td>
                    <td>
                      <Badge tone={DISPATCH[r.dispatch].tone}>{DISPATCH[r.dispatch].label}</Badge>
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

export function ReceiptPage() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const toast = useToast();
  const client = useQueryClient();
  const [format, setFormat] = useState<"A4" | "A5">("A4");
  const [sending, setSending] = useState(false);
  const [to, setTo] = useState("");
  const receipt = useQuery({ queryKey: ["receipt", id], queryFn: () => api.get<ReceiptDetail>(`/receipts/${id}`) });
  usePage(["Reçus", receipt.data?.number ?? "Reçu"]);
  const send = useMutation({
    mutationFn: () => api.post<{ status: string; recipient: string }>(`/receipts/${id}/send`, to.trim() ? { to: to.trim() } : {}),
    onSuccess: async (r) => {
      await client.invalidateQueries({ queryKey: ["receipt", id] });
      toast(
        r.status === "sent" ? `Reçu envoyé à ${r.recipient}.` : "L'envoi a échoué ; il est noté au journal d'envoi.",
        r.status === "sent" ? "success" : "error",
      );
      setSending(false);
    },
  });
  if (receipt.isPending) return <Loading />;
  if (receipt.error) return <ErrorBanner error={receipt.error} retry={() => receipt.refetch()} />;
  const r = receipt.data;
  const s = r.snapshot;
  const firstPrintDone = r.prints.length > 0;
  return (
    <>
      <PageHeader
        title={`Reçu ${r.number}`}
        subtitle={
          <span className="row center" style={{ gap: 8 }}>
            <Badge tone="neutral">{KIND[r.kind]}</Badge>
            {r.cancelledBy ? (
              <Badge tone="gray" strike>
                Annulé par {r.cancelledBy.number}
              </Badge>
            ) : null}
            <span>Émis le {frDateTime(r.issuedAt)}</span>
          </span>
        }
        actions={
          <>
            <select className="input" style={{ width: 90 }} aria-label="Format" value={format} onChange={(e) => setFormat(e.target.value as "A4" | "A5")}>
              <option value="A4">A4</option>
              <option value="A5">A5</option>
            </select>
            <a
              className="btn btn-p"
              href={api.fileUrl(`/receipts/${id}/pdf`, { format })}
              target="_blank"
              rel="noreferrer"
              onClick={() => window.setTimeout(() => client.invalidateQueries({ queryKey: ["receipt", id] }), 1500)}
            >
              {firstPrintDone ? "Imprimer un duplicata" : "Imprimer"}
            </a>
            {can("payments:write") ? (
              <button type="button" className="btn" onClick={() => setSending(true)}>
                Envoyer par e-mail
              </button>
            ) : null}
          </>
        }
      />
      <div className="grid2" style={{ gridTemplateColumns: "3fr 2fr", alignItems: "start" }}>
        <Card title="Aperçu du document archivé">
          <iframe title={`Reçu ${r.number}`} src={api.fileUrl(`/receipts/${id}/view`)} style={{ width: "100%", height: 720, border: 0, display: "block" }} />
        </Card>
        <div className="stack">
          <Card title="Contenu">
            <div className="card-b stack">
              <div>
                <div className="lab">Payeur</div>
                <div>
                  {s.payer.name}
                  {s.payer.guardianName ? <span className="cap"> · tuteur {s.payer.guardianName}</span> : null}
                </div>
              </div>
              <div>
                <div className="lab">Mode</div>
                <div>
                  {METHOD[s.method] ?? s.method}
                  {s.chequeNumber ? ` n° ${s.chequeNumber}, ${s.chequeBank ?? ""}` : ""}
                  {s.reference ? ` · réf. ${s.reference}` : ""}
                </div>
              </div>
              {s.cancels ? (
                <div className="ban ban-red">
                  <span>
                    Annule le reçu {s.cancels.number} : {s.cancels.reason}
                  </span>
                </div>
              ) : null}
            </div>
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
                    <td>Montant</td>
                    <td className="num">{tnd(s.amount)} TND</td>
                  </tr>
                  <tr>
                    <td>Reste à payer après</td>
                    <td className="num">{tnd(s.remainingAfter)} TND</td>
                  </tr>
                  <tr>
                    <td>Solde créditeur après</td>
                    <td className="num">{tnd(s.creditAfter)} TND</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
          <Card title="Impressions et envois">
            <div className="card-b stack">
              {r.prints.length === 0 && r.dispatches.length === 0 ? <span className="cap">Jamais imprimé ni envoyé.</span> : null}
              {r.prints.map((p, i) => (
                <div key={`p${i}`}>
                  {frDateTime(p.printedAt)} · {p.duplicate ? "Duplicata" : "Original"} · {p.printedBy ?? ""}
                </div>
              ))}
              {r.dispatches.map((d, i) => (
                <div key={`d${i}`}>
                  {frDateTime(d.sentAt)} · {d.recipient} ·{" "}
                  <Badge tone={d.status === "sent" ? "green" : "red"}>{d.status === "sent" ? "Envoyé" : "Échec"}</Badge>
                  {d.error ? <div className="cap">{d.error}</div> : null}
                </div>
              ))}
              <div className="cap" style={{ wordBreak: "break-all" }}>
                Empreinte SHA-256 : {r.sha256}
              </div>
            </div>
          </Card>
        </div>
      </div>
      {sending ? (
        <Modal
          title="Envoyer le reçu par e-mail"
          onClose={() => setSending(false)}
          footer={
            <>
              <span />
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn" onClick={() => setSending(false)}>
                  Annuler
                </button>
                <button type="button" className="btn btn-p" disabled={send.isPending} onClick={() => send.mutate()}>
                  Envoyer
                </button>
              </div>
            </>
          }
        >
          <Field label="Destinataire" hint="Laissez vide pour utiliser l'adresse d'envoi des reçus de la fiche.">
            <input className="input" type="email" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <ErrorBanner error={send.error} />
        </Modal>
      ) : null}
    </>
  );
}
