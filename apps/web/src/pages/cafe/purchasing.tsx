import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, ReasonDialog } from "../../components/ui";
import { frDate, tnd, tryParseTnd } from "../../lib/format";
import type { CafeProduct, CafeSupplier } from "./types";

type OrderStatus = "draft" | "ordered" | "received" | "cancelled";
interface Order {
  id: string;
  number: string;
  status: OrderStatus;
  note: string | null;
  total: number;
  createdAt: string;
  orderedAt: string | null;
  receivedAt: string | null;
  cancelReason: string | null;
  supplierName: string;
  createdBy: string | null;
  lines: { productName: string; quantity: number; unitCost: number }[];
}
const STATUS: Record<OrderStatus, { label: string; tone: "gray" | "amber" | "green" }> = {
  draft: { label: "Brouillon", tone: "gray" },
  ordered: { label: "Commandé, à recevoir", tone: "amber" },
  received: { label: "Reçu", tone: "green" },
  cancelled: { label: "Annulé", tone: "gray" },
};

export const useSuppliers = (enabled: boolean) =>
  useQuery({ queryKey: ["cafe-suppliers"], queryFn: () => api.get<CafeSupplier[]>("/cafe/suppliers"), enabled });

function SupplierModal({ supplier, onClose }: { supplier: CafeSupplier | null; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(supplier?.name ?? "");
  const [phone, setPhone] = useState(supplier?.phone ?? "");
  const [email, setEmail] = useState(supplier?.email ?? "");
  const [note, setNote] = useState(supplier?.note ?? "");
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), phone: phone.trim(), email: email.trim(), note: note.trim() };
      return supplier ? api.patch(`/cafe/suppliers/${supplier.id}`, body) : api.post("/cafe/suppliers", body);
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["cafe-suppliers"] });
      toast(supplier ? "Fournisseur modifié." : "Fournisseur créé.");
      onClose();
    },
  });
  return (
    <Modal
      title={supplier ? `Modifier ${supplier.name}` : "Nouveau fournisseur"}
      onClose={onClose}
      footer={
        <>
          <span className="cap">Seul le nom est obligatoire</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <Field label="Nom *">
        <input className="input" autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="grid2">
        <Field label="Téléphone">
          <input className="input" type="tel" value={phone} maxLength={40} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="E-mail">
          <input className="input" type="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      </div>
      <Field label="Note" hint="Jours de livraison, conditions, contact…">
        <input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

export function SuppliersPanel({ manage }: { manage: boolean }) {
  const client = useQueryClient();
  const suppliers = useSuppliers(true);
  const [editing, setEditing] = useState<CafeSupplier | "new" | null>(null);
  const toggle = useMutation({
    mutationFn: (s: CafeSupplier) => api.patch(`/cafe/suppliers/${s.id}`, { active: !s.active }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["cafe-suppliers"] }),
  });
  return (
    <Card
      title="Fournisseurs"
      actions={
        manage ? (
          <button type="button" className="btn btn-p" onClick={() => setEditing("new")}>
            + Nouveau fournisseur
          </button>
        ) : undefined
      }
    >
      <ErrorBanner error={suppliers.error ?? toggle.error} />
      {suppliers.isPending ? (
        <Loading />
      ) : suppliers.data?.length ? (
        <div className="xs">
          <table className="tbl">
            <thead>
              <tr>
                <th>Fournisseur</th>
                <th>Téléphone</th>
                <th>E-mail</th>
                <th>Note</th>
                <th>
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {suppliers.data.map((s) => (
                <tr key={s.id} className={s.active ? undefined : "void"}>
                  <td>
                    {s.name} {s.active ? null : <Badge tone="gray">Archivé</Badge>}
                  </td>
                  <td>{s.phone}</td>
                  <td>{s.email}</td>
                  <td>{s.note}</td>
                  <td>
                    {manage ? (
                      <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
                        <button type="button" className="btn btn-l" onClick={() => setEditing(s)}>
                          Modifier
                        </button>
                        <button type="button" className="btn btn-l" disabled={toggle.isPending} onClick={() => toggle.mutate(s)}>
                          {s.active ? "Archiver" : "Réactiver"}
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="Aucun fournisseur" text="Créez vos fournisseurs pour les nommer à chaque réception." />
      )}
      {editing ? <SupplierModal supplier={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

interface DraftLine {
  productId: string;
  quantityText: string;
  costText: string;
}

function OrderModal({ products, suppliers, onClose }: { products: CafeProduct[]; suppliers: CafeSupplier[]; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const tracked = products.filter((p) => p.active && p.trackStock);
  const [supplierId, setSupplierId] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([{ productId: "", quantityText: "", costText: "" }]);
  const parsed = lines.map((l) => ({
    productId: l.productId,
    quantity: /^\d{1,6}$/.test(l.quantityText.trim()) ? Number(l.quantityText.trim()) : null,
    unitCost: tryParseTnd(l.costText),
  }));
  const complete = parsed.every((l) => l.productId && l.quantity !== null && l.quantity > 0 && l.unitCost !== null);
  const total = parsed.reduce((sum, l) => sum + (l.quantity ?? 0) * (l.unitCost ?? 0), 0);
  const problem = !supplierId ? "Choisissez un fournisseur." : !complete ? "Chaque ligne a besoin d'un produit, d'une quantité et d'un coût unitaire." : null;
  const setLine = (index: number, patch: Partial<DraftLine>) => setLines(lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  const save = useMutation({
    mutationFn: () => api.post("/cafe/purchase-orders", { supplierId, ...(note.trim() ? { note: note.trim() } : {}), lines: parsed }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["cafe-orders"] });
      toast("Bon de commande créé en brouillon.");
      onClose();
    },
  });
  return (
    <Modal
      title="Nouveau bon de commande"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="cap">{problem ?? `Total : ${tnd(total)} TND. Le stock ne bouge qu'à la réception.`}</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={problem !== null || save.isPending} onClick={() => save.mutate()}>
              Créer le brouillon
            </button>
          </div>
        </>
      }
    >
      <div className="grid2">
        <Field label="Fournisseur *">
          <select className="input" autoFocus value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">Choisir…</option>
            {suppliers
              .filter((s) => s.active)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Note">
          <input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      {lines.map((line, index) => (
        <div key={index} className="cafe-order-line">
          <Field label={index === 0 ? "Produit *" : `Produit ${index + 1} *`}>
            <select className="input" value={line.productId} onChange={(e) => setLine(index, { productId: e.target.value })}>
              <option value="">Choisir…</option>
              {tracked
                .filter((p) => p.id === line.productId || !lines.some((l) => l.productId === p.id))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} (en stock : {p.stockQuantity})
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Quantité *">
            <input className="input num" inputMode="numeric" value={line.quantityText} onChange={(e) => setLine(index, { quantityText: e.target.value })} />
          </Field>
          <Field label="Coût unitaire (TND) *">
            <input className="input num" inputMode="decimal" value={line.costText} onChange={(e) => setLine(index, { costText: e.target.value })} />
          </Field>
          <button type="button" className="btn btn-l" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, i) => i !== index))}>
            Retirer
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          className="btn"
          disabled={lines.length >= tracked.length}
          onClick={() => setLines([...lines, { productId: "", quantityText: "", costText: "" }])}
        >
          + Ajouter un produit
        </button>
      </div>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

export function OrdersPanel({ manage, products }: { manage: boolean; products: CafeProduct[] }) {
  const client = useQueryClient();
  const toast = useToast();
  const suppliers = useSuppliers(true);
  const orders = useQuery({ queryKey: ["cafe-orders"], queryFn: () => api.get<Order[]>("/cafe/purchase-orders") });
  const [creating, setCreating] = useState(false);
  const [cancelling, setCancelling] = useState<Order | null>(null);
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ["cafe-orders"] });
    await client.invalidateQueries({ queryKey: ["cafe-products"] });
  };
  const advance = useMutation({
    mutationFn: ({ order, step }: { order: Order; step: "send" | "receive" }) => api.post(`/cafe/purchase-orders/${order.id}/${step}`, {}),
    onSuccess: async (_result, { step }) => {
      await refresh();
      toast(step === "send" ? "Bon de commande marqué comme envoyé." : "Commande reçue : le stock est à jour.");
    },
  });
  const noSupplier = !suppliers.data?.some((s) => s.active);
  return (
    <Card
      title="Bons de commande"
      actions={
        manage ? (
          <>
            {noSupplier && !suppliers.isPending ? <span className="cap">Créez d'abord un fournisseur</span> : null}
            <button type="button" className="btn btn-p" disabled={noSupplier} onClick={() => setCreating(true)}>
              + Nouveau bon de commande
            </button>
          </>
        ) : undefined
      }
    >
      <ErrorBanner error={orders.error ?? advance.error} />
      {orders.isPending ? (
        <Loading />
      ) : orders.data?.length ? (
        <div className="xs">
          <table className="tbl">
            <thead>
              <tr>
                <th>Bon</th>
                <th>Fournisseur</th>
                <th>Produits</th>
                <th className="num">Total (TND)</th>
                <th>État</th>
                <th>
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {orders.data.map((o) => (
                <tr key={o.id} className={o.status === "cancelled" ? "dim" : ""}>
                  <td>
                    {o.number}
                    <div className="cap">{frDate(o.createdAt)}</div>
                  </td>
                  <td>{o.supplierName}</td>
                  <td>{o.lines.map((l) => `${l.quantity} × ${l.productName}`).join(", ")}</td>
                  <td className="num">{tnd(o.total)}</td>
                  <td>
                    <Badge tone={STATUS[o.status].tone}>{STATUS[o.status].label}</Badge>
                    {o.receivedAt ? <div className="cap">le {frDate(o.receivedAt)}</div> : null}
                    {o.cancelReason ? <div className="cap">{o.cancelReason}</div> : null}
                  </td>
                  <td>
                    {manage && (o.status === "draft" || o.status === "ordered") ? (
                      <div className="row" style={{ gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                        <button
                          type="button"
                          className="btn"
                          disabled={advance.isPending}
                          onClick={() => advance.mutate({ order: o, step: o.status === "draft" ? "send" : "receive" })}
                        >
                          {o.status === "draft" ? "Marquer comme envoyé" : "Réceptionner"}
                        </button>
                        <button type="button" className="btn btn-l" onClick={() => setCancelling(o)}>
                          Annuler
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title="Aucun bon de commande"
          text="Préparez une commande, envoyez-la au fournisseur, puis réceptionnez-la : le stock se met à jour à la réception."
        />
      )}
      {creating && suppliers.data ? <OrderModal products={products} suppliers={suppliers.data} onClose={() => setCreating(false)} /> : null}
      {cancelling ? (
        <ReasonDialog
          title={`Annuler le bon ${cancelling.number}`}
          explanation="Le bon reste dans la liste, marqué comme annulé. Le stock n'est pas modifié."
          confirmLabel="Annuler le bon"
          danger
          onClose={() => setCancelling(null)}
          onConfirm={async (reason) => {
            await api.post(`/cafe/purchase-orders/${cancelling.id}/cancel`, { reason });
            await refresh();
            toast("Bon de commande annulé.");
            setCancelling(null);
          }}
        />
      ) : null}
    </Card>
  );
}
