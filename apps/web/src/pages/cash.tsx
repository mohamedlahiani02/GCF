import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api/client";
import { useSession } from "../auth/session";
import { usePage } from "../components/shell";
import { useToast } from "../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Kpi, Loading, Modal, PageHeader } from "../components/ui";
import { addDaysIso, frDate, frDateTime, frTime, todayIso, tnd, tryParseTnd } from "../lib/format";
import { METHOD } from "../lib/labels";

type Method = "cash" | "cheque" | "card" | "transfer";
type Activity = "training" | "rental" | "coworking";

const ACTIVITY: Record<Activity, string> = { training: "Formation et cours", rental: "Locations de salles", coworking: "Coworking" };
const METHODS: Method[] = ["cash", "cheque", "card", "transfer"];
const sum = (totals: Record<Method, number>) => METHODS.reduce((s, m) => s + totals[m], 0);

/** The day's takings per activity; an activity with no movement and no module stays hidden. */
function ActivityTakings({ journal }: { journal: Journal }) {
  const rows = (Object.keys(ACTIVITY) as Activity[]).filter((a) => journal.payments.some((p) => p.activity === a));
  if (rows.length === 0) return null;
  return (
    <Card title="Recette du jour par activité">
      <div className="xs">
        <table className="tbl">
          <thead>
            <tr>
              <th>Activité</th>
              {METHODS.map((m) => (
                <th key={m} className="num">
                  {METHOD[m]}
                </th>
              ))}
              <th className="num">Total (TND)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a}>
                <td>{ACTIVITY[a]}</td>
                {METHODS.map((m) => (
                  <td key={m} className="num">
                    {tnd(journal.byActivity[a][m])}
                  </td>
                ))}
                <td className="num">
                  <strong>{tnd(sum(journal.byActivity[a]))}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

interface Journal {
  day: string;
  payments: {
    id: string;
    receivedAt: string;
    payerName: string | null;
    activity: Activity;
    method: string;
    amount: number;
    status: "valid" | "cancelled";
    kind: "payment" | "refund";
    receiptNumber: string | null;
    createdBy: string | null;
  }[];
  totals: Record<Method, number>;
  byActivity: Record<Activity, Record<Method, number>>;
  expectedCash: number;
  closing: { expectedCash: number; countedCash: number; difference: number; comment: string | null; closedAt: string; closedBy: string | null } | null;
}
interface Closing {
  id: string;
  day: string;
  expectedCash: number;
  countedCash: number;
  difference: number;
  comment: string | null;
  closedAt: string;
  closedBy: string | null;
}

function CloseModal({ journal, onClose }: { journal: Journal; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [countedText, setCountedText] = useState("");
  const [comment, setComment] = useState("");
  const counted = tryParseTnd(countedText);
  const difference = counted === null ? null : counted - journal.expectedCash;
  const close = useMutation({
    mutationFn: () => api.post("/cash/closings", { day: journal.day, countedCash: counted, ...(comment.trim() ? { comment: comment.trim() } : {}) }),
    onSuccess: async () => {
      await client.invalidateQueries();
      toast(`Caisse du ${frDate(journal.day)} clôturée.`);
      onClose();
    },
  });
  return (
    <Modal
      title={`Clôturer la caisse du ${frDate(journal.day)}`}
      onClose={onClose}
      footer={
        <>
          <span className="cap">Après clôture, aucun mouvement d'argent n'est possible sur cette journée</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-p"
              disabled={counted === null || counted < 0 || (difference !== 0 && !comment.trim()) || close.isPending}
              onClick={() => close.mutate()}
            >
              Clôturer
            </button>
          </div>
        </>
      }
    >
      <div className="grid2">
        <div>
          <div className="lab">Espèces attendues</div>
          <div className="amt-s num" style={{ textAlign: "start" }}>
            {tnd(journal.expectedCash)} TND
          </div>
        </div>
        <Field label="Espèces comptées (TND)" error={countedText && counted === null ? "Montant invalide" : null}>
          <input className="input num" inputMode="decimal" autoFocus value={countedText} onChange={(e) => setCountedText(e.target.value)} />
        </Field>
      </div>
      {difference !== null ? (
        difference === 0 ? (
          <div className="ban ban-green">
            <span>Aucun écart.</span>
          </div>
        ) : (
          <div className="ban ban-amber">
            <strong>Écart de {tnd(difference)} TND</strong>
            <span>Un commentaire est obligatoire.</span>
          </div>
        )
      ) : null}
      <Field label={difference ? "Commentaire (obligatoire)" : "Commentaire"}>
        <textarea className="input" value={comment} maxLength={1000} onChange={(e) => setComment(e.target.value)} />
      </Field>
      <ErrorBanner error={close.error} />
    </Modal>
  );
}

export function CashPage() {
  usePage(["Caisse"]);
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const date = params.get("date") ?? todayIso();
  const [closing, setClosing] = useState(false);
  const journal = useQuery({ queryKey: ["cash-journal", date], queryFn: () => api.get<Journal>("/cash/journal", { date }) });
  const history = useQuery({ queryKey: ["cash-closings"], queryFn: () => api.get<Closing[]>("/cash/closings") });
  const j = journal.data;
  return (
    <>
      <PageHeader
        title="Caisse"
        subtitle={j ? j.closing ? <Badge tone="green">Journée clôturée</Badge> : <Badge tone="amber">Journée ouverte</Badge> : undefined}
        actions={
          <>
            <button type="button" className="btn btn-g" aria-label="Jour précédent" onClick={() => setParams({ date: addDaysIso(date, -1) })}>
              ‹
            </button>
            <input
              className="input"
              type="date"
              aria-label="Date"
              value={date}
              max={todayIso()}
              onChange={(e) => e.target.value && setParams({ date: e.target.value })}
            />
            <button
              type="button"
              className="btn btn-g"
              aria-label="Jour suivant"
              disabled={date >= todayIso()}
              onClick={() => setParams({ date: addDaysIso(date, 1) })}
            >
              ›
            </button>
            {can("cash:close") && j && !j.closing && date <= todayIso() ? (
              <button type="button" className="btn btn-p" onClick={() => setClosing(true)}>
                Clôturer la journée
              </button>
            ) : null}
          </>
        }
      />
      <ErrorBanner error={journal.error} retry={() => journal.refetch()} />
      {journal.isPending ? (
        <Loading />
      ) : j ? (
        <>
          <div className="grid4">
            <Kpi label="Espèces" value={<span className="num">{tnd(j.totals.cash)}</span>} sub="TND attendus en caisse" />
            <Kpi label="Chèques" value={<span className="num">{tnd(j.totals.cheque)}</span>} sub="TND" />
            <Kpi label="Cartes" value={<span className="num">{tnd(j.totals.card)}</span>} sub="TND" />
            <Kpi label="Virements" value={<span className="num">{tnd(j.totals.transfer)}</span>} sub="TND" />
          </div>
          {j.closing ? (
            <div className={j.closing.difference === 0 ? "ban ban-green" : "ban ban-amber"}>
              <strong>Clôturée le {frDateTime(j.closing.closedAt)}</strong>
              <span>
                par {j.closing.closedBy} · attendu {tnd(j.closing.expectedCash)} TND, compté {tnd(j.closing.countedCash)} TND, écart {tnd(j.closing.difference)}{" "}
                TND
                {j.closing.comment ? ` · ${j.closing.comment}` : ""}
              </span>
            </div>
          ) : null}
          <ActivityTakings journal={j} />
          <Card title={`Journal du ${frDate(j.day)}`}>
            {j.payments.length === 0 ? (
              <Empty title="Aucun mouvement ce jour" />
            ) : (
              <div className="xs">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Heure</th>
                      <th>Payeur</th>
                      <th>Activité</th>
                      <th>Reçu</th>
                      <th>Mode</th>
                      <th className="num">Montant (TND)</th>
                      <th>Statut</th>
                      <th>Saisi par</th>
                    </tr>
                  </thead>
                  <tbody>
                    {j.payments.map((p) => (
                      <tr key={p.id} className={p.status === "cancelled" ? "dim" : ""}>
                        <td>{frTime(p.receivedAt)}</td>
                        <td>{p.payerName}</td>
                        <td>{ACTIVITY[p.activity]}</td>
                        <td>{p.receiptNumber ?? ""}</td>
                        <td>{METHOD[p.method] ?? p.method}</td>
                        <td className="num">{tnd(p.amount)}</td>
                        <td>
                          {p.status === "cancelled" ? (
                            <Badge tone="gray" strike>
                              Annulé
                            </Badge>
                          ) : p.kind === "refund" ? (
                            <Badge tone="violet">Remboursement</Badge>
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
        </>
      ) : null}
      <Card title="Clôtures précédentes">
        <ErrorBanner error={history.error} />
        {history.data?.length === 0 ? (
          <Empty title="Aucune clôture" />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Jour</th>
                  <th className="num">Attendu</th>
                  <th className="num">Compté</th>
                  <th className="num">Écart</th>
                  <th>Commentaire</th>
                  <th>Clôturée par</th>
                </tr>
              </thead>
              <tbody>
                {history.data?.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/caisse?date=${c.day}`}>{frDate(c.day)}</Link>
                    </td>
                    <td className="num">{tnd(c.expectedCash)}</td>
                    <td className="num">{tnd(c.countedCash)}</td>
                    <td className="num">{c.difference === 0 ? tnd(0) : <Badge tone="amber">{tnd(c.difference)}</Badge>}</td>
                    <td>{c.comment ?? ""}</td>
                    <td>
                      {c.closedBy}
                      <div className="cap">{frDateTime(c.closedAt)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {closing && j ? <CloseModal journal={j} onClose={() => setClosing(false)} /> : null}
    </>
  );
}
