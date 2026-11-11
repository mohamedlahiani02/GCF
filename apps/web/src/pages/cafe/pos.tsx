import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { api } from "../../api/client";
import { useSession } from "../../auth/session";
import { usePage } from "../../components/shell";
import { Empty, ErrorBanner, Field, Loading, Modal, PageHeader, Segmented } from "../../components/ui";
import { frDateTime, tnd, tryParseTnd } from "../../lib/format";
import { CAFE_METHOD, isLow, type CafeMethod, type CafeProduct, type CafeSettings, type CafeTicket } from "./types";

const OTHER = "Autres";

function Ticket({ ticket, onClose }: { ticket: CafeTicket; onClose: () => void }) {
  return (
    <Modal
      title={`Vente ${ticket.number}`}
      onClose={onClose}
      footer={
        <>
          <span className="cap">{frDateTime(ticket.soldAt)}</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={() => window.print()}>
              Imprimer le ticket
            </button>
            <button type="button" className="btn btn-p" autoFocus onClick={onClose}>
              Nouvelle vente
            </button>
          </div>
        </>
      }
    >
      <div className="cafe-ticket">
        <table className="tbl">
          <tbody>
            {ticket.lines.map((l) => (
              <tr key={l.productName}>
                <td>
                  {l.quantity} × {l.productName}
                </td>
                <td className="num">{tnd(l.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total ({CAFE_METHOD[ticket.method]})</td>
              <td className="num">
                <strong>{tnd(ticket.total)} TND</strong>
              </td>
            </tr>
          </tfoot>
        </table>
        {ticket.change !== null ? (
          <div className="ban ban-green">
            Reçu {tnd(ticket.cashReceived)} TND. <strong>À rendre : {tnd(ticket.change)} TND</strong>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

export function CafePosPage() {
  usePage(["Café", "Vente au comptoir"]);
  const { can } = useSession();
  const client = useQueryClient();
  const products = useQuery({ queryKey: ["cafe-products"], queryFn: () => api.get<CafeProduct[]>("/cafe/products") });
  const settings = useQuery({ queryKey: ["cafe-settings"], queryFn: () => api.get<CafeSettings>("/cafe/settings") });
  const [cart, setCart] = useState<Record<string, number>>({});
  const [method, setMethod] = useState<CafeMethod>("cash");
  const [receivedText, setReceivedText] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [ticket, setTicket] = useState<CafeTicket | null>(null);

  const list = products.data ?? [];
  const categories = useMemo(() => [...new Set(list.map((p) => p.category ?? OTHER))], [list]);
  const shown = category === null ? list : list.filter((p) => (p.category ?? OTHER) === category);
  const lines = list.filter((p) => cart[p.id]).map((p) => ({ product: p, quantity: cart[p.id]! }));
  const total = lines.reduce((sum, l) => sum + l.product.price * l.quantity, 0);
  const received = tryParseTnd(receivedText);
  const allowNegative = settings.data?.allowNegativeStock ?? false;
  const available = (p: CafeProduct) => (p.trackStock && !allowNegative ? p.stockQuantity : Infinity);

  const setQuantity = (p: CafeProduct, quantity: number) =>
    setCart((current) => {
      const next = { ...current };
      const capped = Math.min(quantity, available(p));
      if (capped <= 0) delete next[p.id];
      else next[p.id] = capped;
      return next;
    });

  const sell = useMutation({
    mutationFn: () =>
      api.post<CafeTicket>("/cafe/sales", {
        lines: lines.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
        method,
        expectedTotal: total,
        ...(method === "cash" && received !== null ? { cashReceived: received } : {}),
      }),
    onSuccess: async (sale) => {
      setTicket(sale);
      setCart({});
      setReceivedText("");
      await client.invalidateQueries({ queryKey: ["cafe-products"] });
      await client.invalidateQueries({ queryKey: ["cafe-journal"] });
    },
    onError: () => client.invalidateQueries({ queryKey: ["cafe-products"] }),
  });

  const blocked = !can("cafe:sell")
    ? "Votre rôle ne permet pas d'enregistrer une vente."
    : lines.length === 0
      ? "Ajoutez un produit pour encaisser."
      : method === "cash" && receivedText.trim() !== "" && received === null
        ? "Le montant reçu est invalide."
        : method === "cash" && received !== null && received < total
          ? "Le montant reçu ne couvre pas la vente."
          : null;

  return (
    <>
      <PageHeader
        title="Vente au comptoir"
        subtitle="Touchez un produit pour l'ajouter au ticket."
        actions={
          <Link className="btn" to="/cafe/caisse">
            Caisse du café
          </Link>
        }
      />
      <ErrorBanner error={products.error} />
      {products.isPending ? (
        <Loading />
      ) : list.length === 0 ? (
        <div className="card">
          <Empty
            title="Aucun produit à vendre"
            text="Créez vos produits (café, eau, viennoiseries…) avant la première vente."
            action={
              can("cafe:manage") ? (
                <Link className="btn btn-p" to="/cafe/produits">
                  Créer les produits
                </Link>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="cafe-pos">
          <section aria-label="Produits">
            {categories.length > 1 ? (
              <div className="cafe-cats" role="group" aria-label="Catégories">
                {[null, ...categories].map((c) => (
                  <button key={c ?? "all"} type="button" className="cafe-cat" aria-pressed={category === c} onClick={() => setCategory(c)}>
                    {c ?? "Tout"}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="cafe-grid">
              {shown.map((p) => {
                const out = available(p) <= (cart[p.id] ?? 0);
                return (
                  <button key={p.id} type="button" className="cafe-product" disabled={out} onClick={() => setQuantity(p, (cart[p.id] ?? 0) + 1)}>
                    <span className="cafe-product-name">{p.name}</span>
                    <span className="cafe-product-price num">{tnd(p.price)}</span>
                    {p.trackStock ? (
                      <span className={out || isLow(p) ? "cafe-product-stock low" : "cafe-product-stock"}>
                        {p.stockQuantity <= 0 ? "Rupture de stock" : `${p.stockQuantity} en stock`}
                      </span>
                    ) : null}
                    {cart[p.id] ? <span className="cafe-product-count">{cart[p.id]}</span> : null}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="card cafe-cart" aria-label="Ticket en cours">
            <div className="card-h">
              <h2 className="h2">Ticket</h2>
              {lines.length ? (
                <button type="button" className="btn btn-l" onClick={() => setCart({})}>
                  Vider
                </button>
              ) : null}
            </div>
            <div className="card-b stack">
              {lines.length === 0 ? (
                <p className="cap">Le ticket est vide.</p>
              ) : (
                <ul className="cafe-lines">
                  {lines.map(({ product, quantity }) => (
                    <li key={product.id}>
                      <span className="cafe-line-name">{product.name}</span>
                      <span className="cafe-qty">
                        <button
                          type="button"
                          className="btn btn-g"
                          aria-label={`Retirer un ${product.name}`}
                          onClick={() => setQuantity(product, quantity - 1)}
                        >
                          −
                        </button>
                        <span className="num" aria-live="polite">
                          {quantity}
                        </span>
                        <button
                          type="button"
                          className="btn btn-g"
                          aria-label={`Ajouter un ${product.name}`}
                          disabled={available(product) <= quantity}
                          onClick={() => setQuantity(product, quantity + 1)}
                        >
                          +
                        </button>
                      </span>
                      <span className="num cafe-line-total">{tnd(product.price * quantity)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="cafe-total">
                <span>Total</span>
                <strong className="num">{tnd(total)} TND</strong>
              </div>
              <Segmented
                label="Mode de paiement"
                value={method}
                onChange={setMethod}
                options={[
                  { value: "cash", label: CAFE_METHOD.cash },
                  { value: "card", label: CAFE_METHOD.card },
                ]}
              />
              {method === "cash" ? (
                <Field
                  label="Montant reçu (TND), facultatif"
                  hint={received !== null && received >= total && total > 0 ? `À rendre : ${tnd(received - total)} TND` : undefined}
                >
                  <input className="input num" inputMode="decimal" value={receivedText} onChange={(e) => setReceivedText(e.target.value)} />
                </Field>
              ) : null}
              <ErrorBanner error={sell.error} />
              <button type="button" className="btn btn-p cafe-pay" disabled={blocked !== null || sell.isPending} onClick={() => sell.mutate()}>
                Encaisser {total > 0 ? `${tnd(total)} TND` : ""}
              </button>
              {blocked && lines.length > 0 ? <p className="cap">{blocked}</p> : null}
            </div>
          </section>
        </div>
      )}
      {ticket ? <Ticket ticket={ticket} onClose={() => setTicket(null)} /> : null}
    </>
  );
}
