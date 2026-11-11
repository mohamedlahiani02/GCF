import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import { useSession } from "../../auth/session";
import { usePage } from "../../components/shell";
import { useToast } from "../../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, PageHeader, Segmented, Tabs } from "../../components/ui";
import { frDateTime, tnd, tryParseTnd } from "../../lib/format";
import { OrdersPanel, SuppliersPanel, useSuppliers } from "./purchasing";
import { isLow, type CafeProduct, type CafeSettings } from "./types";

type StockKind = "purchase" | "loss" | "count";
interface Movement {
  id: string;
  kind: StockKind | "sale" | "sale_cancelled";
  quantity: number;
  quantityAfter: number;
  unitCost: number | null;
  reason: string | null;
  createdAt: string;
  saleNumber: string | null;
  supplierName: string | null;
  orderNumber: string | null;
  createdBy: string | null;
}
const KIND: Record<Movement["kind"], string> = {
  purchase: "Réception",
  loss: "Perte",
  count: "Inventaire",
  sale: "Vente",
  sale_cancelled: "Vente annulée",
};
const wholeNumber = (text: string): number | null => (/^\d{1,6}$/.test(text.trim()) ? Number(text.trim()) : null);

function ProductModal({ product, onClose }: { product: CafeProduct | null; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(product?.name ?? "");
  const [category, setCategory] = useState(product?.category ?? "");
  const [priceText, setPriceText] = useState(product ? tnd(product.price) : "");
  const [trackStock, setTrackStock] = useState(product?.trackStock ?? true);
  const [thresholdText, setThresholdText] = useState(product?.lowStockThreshold?.toString() ?? "");
  const price = tryParseTnd(priceText);
  const threshold = thresholdText.trim() === "" ? null : wholeNumber(thresholdText);
  const thresholdOk = thresholdText.trim() === "" || threshold !== null;
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), category: category.trim(), price, trackStock, lowStockThreshold: trackStock ? threshold : null };
      return product ? api.patch(`/cafe/products/${product.id}`, body) : api.post("/cafe/products", body);
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["cafe-products"] });
      toast(product ? "Produit modifié." : "Produit créé.");
      onClose();
    },
  });
  return (
    <Modal
      title={product ? `Modifier ${product.name}` : "Nouveau produit"}
      onClose={onClose}
      footer={
        <>
          <span className="cap">Le prix s'applique aux prochaines ventes</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-p"
              disabled={!name.trim() || price === null || !thresholdOk || save.isPending}
              onClick={() => save.mutate()}
            >
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <Field label="Nom *">
        <input className="input" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="grid2">
        <Field label="Catégorie" hint="Regroupe les produits à la vente : Boissons, Snacks…">
          <input className="input" value={category} maxLength={60} onChange={(e) => setCategory(e.target.value)} />
        </Field>
        <Field label="Prix de vente (TND) *" error={priceText && price === null ? "Montant invalide" : null}>
          <input className="input num" inputMode="decimal" value={priceText} onChange={(e) => setPriceText(e.target.value)} />
        </Field>
      </div>
      <label className="row center" style={{ gap: 8 }}>
        <input type="checkbox" className="chk" checked={trackStock} onChange={(e) => setTrackStock(e.target.checked)} />
        Suivre le stock de ce produit
      </label>
      <p className="cap">Décochez pour ce qui se prépare sur place sans stock compté, comme un café express.</p>
      {trackStock ? (
        <Field
          label="Seuil d'alerte"
          hint="Le produit est signalé quand le stock atteint ce nombre. Vide : pas d'alerte."
          error={thresholdOk ? null : "Nombre entier attendu"}
        >
          <input className="input num" inputMode="numeric" value={thresholdText} onChange={(e) => setThresholdText(e.target.value)} />
        </Field>
      ) : null}
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

function StockModal({ product, purchasing, onClose }: { product: CafeProduct; purchasing: CafeSettings["purchasing"]; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const byOrder = purchasing === "orders";
  const suppliers = useSuppliers(purchasing === "suppliers");
  const [kind, setKind] = useState<StockKind>(byOrder ? "count" : "purchase");
  const [supplierId, setSupplierId] = useState("");
  const [quantityText, setQuantityText] = useState("");
  const [costText, setCostText] = useState("");
  const [reason, setReason] = useState("");
  const quantity = wholeNumber(quantityText);
  const cost = tryParseTnd(costText);
  const after =
    quantity === null ? null : kind === "purchase" ? product.stockQuantity + quantity : kind === "loss" ? product.stockQuantity - quantity : quantity;
  const needsReason = kind !== "purchase";
  const problem =
    quantity === null || (kind !== "count" && quantity === 0)
      ? "Indiquez une quantité entière."
      : kind === "count" && quantity === product.stockQuantity
        ? "Le stock compté est déjà le stock enregistré."
        : needsReason && !reason.trim()
          ? "Le motif est obligatoire."
          : kind === "purchase" && purchasing === "suppliers" && !supplierId
            ? "Choisissez le fournisseur de cette réception."
            : costText.trim() !== "" && cost === null
              ? "Le coût unitaire est invalide."
              : null;
  const save = useMutation({
    mutationFn: () =>
      api.post(`/cafe/products/${product.id}/stock`, {
        kind,
        ...(kind === "count" ? { counted: quantity } : { quantity }),
        ...(kind === "purchase" && cost !== null ? { unitCost: cost } : {}),
        ...(kind === "purchase" && supplierId ? { supplierId } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["cafe-products"] });
      await client.invalidateQueries({ queryKey: ["cafe-movements", product.id] });
      toast("Stock mis à jour.");
      onClose();
    },
  });
  return (
    <Modal
      title={`Stock : ${product.name}`}
      onClose={onClose}
      footer={
        <>
          <span className="cap">{problem ?? "Mouvement tracé au journal d'audit"}</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={problem !== null || save.isPending} onClick={() => save.mutate()}>
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <Segmented
        label="Type de mouvement"
        value={kind}
        onChange={setKind}
        options={[
          { value: "purchase", label: "Réception", disabled: byOrder },
          { value: "loss", label: "Perte" },
          { value: "count", label: "Inventaire" },
        ]}
      />
      <div className="grid2">
        <Field
          label={kind === "count" ? "Quantité comptée *" : "Quantité *"}
          hint={`En stock : ${product.stockQuantity}${after !== null ? `, après : ${after}` : ""}`}
        >
          <input className="input num" inputMode="numeric" autoFocus value={quantityText} onChange={(e) => setQuantityText(e.target.value)} />
        </Field>
        {kind === "purchase" ? (
          <Field label="Coût unitaire d'achat (TND)" hint="Facultatif">
            <input className="input num" inputMode="decimal" value={costText} onChange={(e) => setCostText(e.target.value)} />
          </Field>
        ) : null}
      </div>
      <Field label={needsReason ? "Motif *" : "Note"}>
        <input className="input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

function HistoryModal({ product, onClose }: { product: CafeProduct; onClose: () => void }) {
  const movements = useQuery({ queryKey: ["cafe-movements", product.id], queryFn: () => api.get<Movement[]>(`/cafe/products/${product.id}/movements`) });
  return (
    <Modal title={`Mouvements : ${product.name}`} onClose={onClose} wide>
      <ErrorBanner error={movements.error} />
      {movements.isPending ? (
        <Loading />
      ) : movements.data?.length ? (
        <div className="xs">
          <table className="tbl">
            <thead>
              <tr>
                <th>Date</th>
                <th>Mouvement</th>
                <th className="num">Quantité</th>
                <th className="num">Stock après</th>
                <th>Détail</th>
                <th>Par</th>
              </tr>
            </thead>
            <tbody>
              {movements.data.map((m) => (
                <tr key={m.id}>
                  <td>{frDateTime(m.createdAt)}</td>
                  <td>{KIND[m.kind]}</td>
                  <td className="num">{m.quantity > 0 ? `+${m.quantity}` : m.quantity}</td>
                  <td className="num">{m.quantityAfter}</td>
                  <td>
                    {[m.saleNumber, m.orderNumber, m.supplierName, m.unitCost !== null ? `${tnd(m.unitCost)} TND l'unité` : null, m.reason]
                      .filter(Boolean)
                      .join(" · ")}
                  </td>
                  <td>{m.createdBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="Aucun mouvement" text="Les réceptions, ventes, pertes et inventaires de ce produit apparaîtront ici." />
      )}
    </Modal>
  );
}

function SettingsModal({ settings, onClose }: { settings: CafeSettings; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [floatText, setFloatText] = useState(tnd(settings.openingFloat));
  const [allowNegative, setAllowNegative] = useState(settings.allowNegativeStock);
  const [prefix, setPrefix] = useState(settings.ticketPrefix);
  const [ticketPrinting, setTicketPrinting] = useState(settings.ticketPrinting);
  const [purchasing, setPurchasing] = useState(settings.purchasing);
  const openingFloat = tryParseTnd(floatText);
  const prefixOk = /^[A-Z0-9]{1,8}$/.test(prefix);
  const save = useMutation({
    mutationFn: () => api.put("/cafe/settings", { openingFloat, allowNegativeStock: allowNegative, ticketPrefix: prefix, ticketPrinting, purchasing }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["cafe-settings"] });
      await client.invalidateQueries({ queryKey: ["cafe-journal"] });
      toast("Réglages du café enregistrés.");
      onClose();
    },
  });
  return (
    <Modal
      title="Réglages du café"
      onClose={onClose}
      footer={
        <>
          <span className="cap">S'applique aux journées non clôturées</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={openingFloat === null || !prefixOk || save.isPending} onClick={() => save.mutate()}>
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <div className="grid2">
        <Field
          label="Fond de caisse (TND)"
          hint="Les espèces laissées dans la caisse du café chaque matin."
          error={openingFloat === null ? "Montant invalide" : null}
        >
          <input className="input num" inputMode="decimal" value={floatText} onChange={(e) => setFloatText(e.target.value)} />
        </Field>
        <Field label="Préfixe des tickets" hint="1 à 8 majuscules ou chiffres, par exemple CAF." error={prefixOk ? null : "Préfixe invalide"}>
          <input className="input" value={prefix} maxLength={8} onChange={(e) => setPrefix(e.target.value.toUpperCase())} />
        </Field>
      </div>
      <div className="grid2">
        <Field label="Impression du ticket" hint="Sans imprimante, la vente affiche seulement la monnaie à rendre.">
          <select className="input" value={ticketPrinting} onChange={(e) => setTicketPrinting(e.target.value as CafeSettings["ticketPrinting"])}>
            <option value="none">Pas d'impression</option>
            <option value="browser">Imprimante de bureau (A4)</option>
            <option value="thermal_80">Imprimante à tickets 80 mm</option>
            <option value="thermal_58">Imprimante à tickets 58 mm</option>
          </select>
        </Field>
        <Field label="Achats" hint="Comment le café enregistre ce qu'il achète.">
          <select className="input" value={purchasing} onChange={(e) => setPurchasing(e.target.value as CafeSettings["purchasing"])}>
            <option value="simple">Réception simple, sans fournisseur</option>
            <option value="suppliers">Réception avec fournisseur</option>
            <option value="orders">Bons de commande puis réception</option>
          </select>
        </Field>
      </div>
      <label className="row center" style={{ gap: 8 }}>
        <input type="checkbox" className="chk" checked={allowNegative} onChange={(e) => setAllowNegative(e.target.checked)} />
        Autoriser la vente d'un produit en rupture de stock
      </label>
      <p className="cap">Coché : la vente passe et le stock devient négatif jusqu'à la prochaine réception ou au prochain inventaire.</p>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

export function CafeStockPage() {
  usePage(["Café", "Produits et stock"]);
  const { can } = useSession();
  const client = useQueryClient();
  const manage = can("cafe:manage");
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<CafeProduct | "new" | null>(null);
  const [stock, setStock] = useState<CafeProduct | null>(null);
  const [history, setHistory] = useState<CafeProduct | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<"products" | "suppliers" | "orders">("products");
  const products = useQuery({ queryKey: ["cafe-products", "all"], queryFn: () => api.get<CafeProduct[]>("/cafe/products", { all: "true" }) });
  const settings = useQuery({ queryKey: ["cafe-settings"], queryFn: () => api.get<CafeSettings>("/cafe/settings") });
  const toggle = useMutation({
    mutationFn: (p: CafeProduct) => api.patch(`/cafe/products/${p.id}`, { active: !p.active }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["cafe-products"] }),
  });
  const all = products.data ?? [];
  const shown = showInactive ? all : all.filter((p) => p.active);
  const low = all.filter((p) => p.active && isLow(p));
  const purchasing = settings.data?.purchasing ?? "simple";
  const tabs = [
    { value: "products" as const, label: "Produits" },
    ...(purchasing !== "simple" ? [{ value: "suppliers" as const, label: "Fournisseurs" }] : []),
    ...(purchasing === "orders" ? [{ value: "orders" as const, label: "Bons de commande" }] : []),
  ];
  const shownTab = tabs.some((t) => t.value === tab) ? tab : "products";
  return (
    <>
      <PageHeader
        title="Produits et stock"
        subtitle="Ce que le café vend, à quel prix, et ce qu'il reste en stock."
        actions={
          manage ? (
            <>
              <button type="button" className="btn" disabled={!settings.data} onClick={() => setSettingsOpen(true)}>
                Réglages du café
              </button>
              <button type="button" className="btn btn-p" onClick={() => setEditing("new")}>
                + Nouveau produit
              </button>
            </>
          ) : undefined
        }
      />
      <ErrorBanner error={products.error ?? toggle.error} />
      {low.length ? (
        <div className="ban ban-amber" role="status">
          Stock bas : {low.map((p) => `${p.name} (${p.stockQuantity})`).join(", ")}.
        </div>
      ) : null}
      {tabs.length > 1 ? <Tabs value={shownTab} onChange={setTab} tabs={tabs} /> : null}
      {shownTab === "suppliers" ? <SuppliersPanel manage={manage} /> : null}
      {shownTab === "orders" ? <OrdersPanel manage={manage} products={all} /> : null}
      {shownTab === "products" ? (
        <Card
          title="Produits"
          actions={
            all.some((p) => !p.active) ? (
              <label className="row center cap" style={{ gap: 6 }}>
                <input type="checkbox" className="chk" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
                Afficher les produits retirés
              </label>
            ) : undefined
          }
        >
          {products.isPending ? (
            <Loading />
          ) : shown.length === 0 ? (
            <Empty
              title="Aucun produit"
              text={manage ? "Créez votre premier produit pour ouvrir la vente au comptoir." : "Un administrateur doit créer les produits du café."}
            />
          ) : (
            <div className="xs">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Produit</th>
                    <th>Catégorie</th>
                    <th className="num">Prix (TND)</th>
                    <th className="num">Stock</th>
                    <th>
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p) => (
                    <tr key={p.id} className={p.active ? undefined : "void"}>
                      <td>
                        {p.name} {p.active ? null : <Badge tone="gray">Retiré</Badge>}
                      </td>
                      <td>{p.category}</td>
                      <td className="num">{tnd(p.price)}</td>
                      <td className="num">
                        {p.trackStock ? (
                          <>
                            {p.stockQuantity}{" "}
                            {isLow(p) ? <Badge tone={p.stockQuantity <= 0 ? "red" : "amber"}>{p.stockQuantity <= 0 ? "Rupture" : "Bas"}</Badge> : null}
                          </>
                        ) : (
                          <span className="cap">Non suivi</span>
                        )}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                          {manage && p.trackStock && p.active ? (
                            <button type="button" className="btn" onClick={() => setStock(p)}>
                              Mettre à jour le stock
                            </button>
                          ) : null}
                          {p.trackStock ? (
                            <button type="button" className="btn btn-l" onClick={() => setHistory(p)}>
                              Mouvements
                            </button>
                          ) : null}
                          {manage ? (
                            <>
                              <button type="button" className="btn btn-l" onClick={() => setEditing(p)}>
                                Modifier
                              </button>
                              <button type="button" className="btn btn-l" disabled={toggle.isPending} onClick={() => toggle.mutate(p)}>
                                {p.active ? "Retirer de la vente" : "Remettre en vente"}
                              </button>
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}
      {editing ? <ProductModal product={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
      {stock ? <StockModal product={stock} purchasing={purchasing} onClose={() => setStock(null)} /> : null}
      {history ? <HistoryModal product={history} onClose={() => setHistory(null)} /> : null}
      {settingsOpen && settings.data ? <SettingsModal settings={settings.data} onClose={() => setSettingsOpen(false)} /> : null}
    </>
  );
}
