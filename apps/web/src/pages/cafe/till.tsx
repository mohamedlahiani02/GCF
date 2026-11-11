import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../../api/client";
import { useSession } from "../../auth/session";
import { usePage } from "../../components/shell";
import { useToast } from "../../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Kpi, Loading, Modal, PageHeader, ReasonDialog } from "../../components/ui";
import { addDaysIso, frDate, frDateTime, frTime, todayIso, tnd, tryParseTnd } from "../../lib/format";
import { CAFE_METHOD, type CafeMethod, type CafeSaleLine } from "./types";

interface Sale {
  id: string;
  number: string;
  soldAt: string;
  method: CafeMethod;
  total: number;
  status: "valid" | "cancelled";
  cancelReason: string | null;
  createdBy: string | null;
  lines: CafeSaleLine[];
}
interface ClosingSummary {
  openingFloat: number;
  expectedCash: number;
  countedCash: number;
  difference: number;
  comment: string | null;
  closedAt: string;
  closedBy: string | null;
}
interface Journal {
  day: string;
  sales: Sale[];
  totals: Record<CafeMethod, number>;
  openingFloat: number;
  expectedCash: number;
  closing: ClosingSummary | null;
}
interface Closing extends ClosingSummary {
  id: string;
  day: string;
}

function CloseModal({ journal, onClose }: { journal: Journal; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [countedText, setCountedText] = useState("");
  const [comment, setComment] = useState("");
  const counted = tryParseTnd(countedText);
  const difference = counted === null ? null : counted - journal.expectedCash;
  const close = useMutation({
    mutationFn: () => api.post("/cafe/closings", { day: journal.day, countedCash: counted, ...(comment.trim() ? { comment: comment.trim() } : {}) }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["cafe-journal"] });
      await client.invalidateQueries({ queryKey: ["cafe-closings"] });
      toast(`Caisse du café du ${frDate(journal.day)} clôturée.`);
      onClose();
    },
  });
  return (
    <Modal
      title={`Clôturer la caisse du café du ${frDate(journal.day)}`}
      onClose={onClose}
      footer={
        <>
          <span className="cap">Après clôture, plus aucune vente ni annulation sur cette journée</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-p"
              disabled={counted === null || (difference !== 0 && !comment.trim()) || close.isPending}
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
          <div className="cap">
            Fond de caisse {tnd(journal.openingFloat)} + ventes en espèces {tnd(journal.totals.cash)}
          </div>
        </div>
        <Field label="Espèces comptées (TND)" error={countedText && counted === null ? "Montant invalide" : null}>
          <input className="input num" inputMode="decimal" autoFocus value={countedText} onChange={(e) => setCountedText(e.target.value)} />
        </Field>
      </div>
      {difference !== null ? (
        difference === 0 ? (
          <div className="ban ban-green">Aucun écart.</div>
        ) : (
          <div className="ban ban-amber">
            Écart de {tnd(difference)} TND : {difference > 0 ? "il y a plus d'espèces que prévu" : "il manque des espèces"}. Expliquez-le pour clôturer.
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

export function CafeTillPage() {
  usePage(["Café", "Caisse du café"]);
  const { can } = useSession();
  const client = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const date = params.get("date") ?? todayIso();
  const [closing, setClosing] = useState(false);
  const [cancelling, setCancelling] = useState<Sale | null>(null);
  const journal = useQuery({ queryKey: ["cafe-journal", date], queryFn: () => api.get<Journal>("/cafe/journal", { date }) });
  const history = useQuery({ queryKey: ["cafe-closings"], queryFn: () => api.get<Closing[]>("/cafe/closings") });
  const j = journal.data;
  const valid = j?.sales.filter((s) => s.status === "valid").length ?? 0;
  return (
    <>
      <PageHeader
        title="Caisse du café"
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
            {can("cafe:close") && j && !j.closing ? (
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
            <Kpi label="Ventes en espèces" value={<span className="num">{tnd(j.totals.cash)}</span>} sub="TND" />
            <Kpi label="Ventes par carte" value={<span className="num">{tnd(j.totals.card)}</span>} sub="TND" />
            <Kpi label="Fond de caisse" value={<span className="num">{tnd(j.openingFloat)}</span>} sub="TND laissés le matin" />
            <Kpi label="Espèces attendues" value={<span className="num">{tnd(j.expectedCash)}</span>} sub={`TND · ${valid} vente(s)`} />
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
          <Card title={`Ventes du ${frDate(j.day)}`}>
            {j.sales.length === 0 ? (
              <Empty
                title="Aucune vente ce jour"
                action={
                  date === todayIso() && !j.closing && can("cafe:sell") ? (
                    <Link className="btn btn-p" to="/cafe">
                      Ouvrir la vente au comptoir
                    </Link>
                  ) : undefined
                }
              />
            ) : (
              <div className="xs">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Heure</th>
                      <th>Ticket</th>
                      <th>Produits</th>
                      <th>Mode</th>
                      <th className="num">Montant (TND)</th>
                      <th>Statut</th>
                      <th>Vendu par</th>
                      <th>
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {j.sales.map((s) => (
                      <tr key={s.id} className={s.status === "cancelled" ? "dim" : ""}>
                        <td>{frTime(s.soldAt)}</td>
                        <td>{s.number}</td>
                        <td>{s.lines.map((l) => `${l.quantity} × ${l.productName}`).join(", ")}</td>
                        <td>{CAFE_METHOD[s.method]}</td>
                        <td className="num">{tnd(s.total)}</td>
                        <td>
                          {s.status === "cancelled" ? (
                            <>
                              <Badge tone="gray" strike>
                                Annulée
                              </Badge>
                              <div className="cap">{s.cancelReason}</div>
                            </>
                          ) : (
                            <Badge tone="green">Valide</Badge>
                          )}
                        </td>
                        <td>{s.createdBy ?? ""}</td>
                        <td>
                          {s.status === "valid" && !j.closing && can("cafe:cancel") ? (
                            <button type="button" className="btn btn-l" onClick={() => setCancelling(s)}>
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
                  <th className="num">Fond de caisse</th>
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
                      <Link to={`/cafe/caisse?date=${c.day}`}>{frDate(c.day)}</Link>
                    </td>
                    <td className="num">{tnd(c.openingFloat)}</td>
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
      {cancelling ? (
        <ReasonDialog
          title={`Annuler la vente ${cancelling.number}`}
          explanation={`${tnd(cancelling.total)} TND seront retirés de la caisse du café et les produits suivis reviendront en stock.`}
          confirmLabel="Annuler la vente"
          danger
          onClose={() => setCancelling(null)}
          onConfirm={async (reason) => {
            await api.post(`/cafe/sales/${cancelling.id}/cancel`, { reason });
            await client.invalidateQueries({ queryKey: ["cafe-journal"] });
            await client.invalidateQueries({ queryKey: ["cafe-products"] });
            toast("Vente annulée.");
            setCancelling(null);
          }}
        />
      ) : null}
    </>
  );
}
