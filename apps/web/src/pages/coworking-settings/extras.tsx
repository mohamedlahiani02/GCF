import { isBookableCategory } from "@gcf/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, Money, ReasonDialog, Segmented } from "../../components/ui";
import { tnd, tryParseTnd } from "../../lib/format";
import { CW_KEYS, EXTRA_PRICING, type Extra, type ExtraPricing, type ResourceType } from "./api";
import { parseInteger } from "./helpers";

function ExtraModal({ extra, types, onClose }: { extra: Extra | null; types: ResourceType[]; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(extra?.name ?? "");
  const [typeId, setTypeId] = useState(extra?.typeId ?? types[0]?.id ?? "");
  const [pricing, setPricing] = useState<ExtraPricing>(extra?.pricing ?? "fixed");
  const [amount, setAmount] = useState(extra ? tnd(extra.amount) : "");
  const [memberAmount, setMemberAmount] = useState(extra?.memberAmount != null ? tnd(extra.memberAmount) : "");
  const [maxQuantity, setMaxQuantity] = useState(String(extra?.maxQuantity ?? 10));
  const [isPublic, setPublic] = useState(extra?.public ?? true);
  const amountValue = tryParseTnd(amount);
  const memberValue = memberAmount.trim() ? tryParseTnd(memberAmount) : null;
  const memberOk = !memberAmount.trim() || memberValue !== null;
  const maxValue = pricing === "fixed" ? 1 : parseInteger(maxQuantity, 1, 500);
  const valid = name.trim() !== "" && !!typeId && amountValue !== null && memberOk && maxValue !== null;
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), pricing, amount: amountValue, memberAmount: memberValue, maxQuantity: maxValue, public: isPublic };
      return extra ? api.patch(`/coworking/extras/${extra.id}`, body) : api.post("/coworking/extras", { ...body, typeId });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: CW_KEYS.extras });
      toast(extra ? "Option modifiée. Les réservations déjà faites gardent leur prix." : "Option créée.");
      onClose();
    },
  });
  return (
    <Modal
      title={extra ? `Modifier ${extra.name}` : "Nouvelle option"}
      onClose={onClose}
      footer={
        <>
          <span />
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <Field label="Nom *" hint="Par exemple : Écran et projecteur, Pause café, Chaise supplémentaire.">
        <input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Type d'espace *" hint={extra ? "Le type d'une option ne change pas : archivez-la et créez-en une autre." : undefined}>
        <select className="input" value={typeId} disabled={!!extra} onChange={(e) => setTypeId(e.target.value)}>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="stack" style={{ gap: 6 }}>
        <span className="lab">Calcul du prix</span>
        <Segmented
          label="Calcul du prix"
          value={pricing}
          onChange={setPricing}
          options={(Object.keys(EXTRA_PRICING) as ExtraPricing[]).map((value) => ({ value, label: EXTRA_PRICING[value] }))}
        />
      </div>
      <div className="grid2">
        <Field label="Prix TTC (TND) *" error={amount.trim() && amountValue === null ? "Montant invalide" : null}>
          <input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Prix pour les abonnés (TND)" hint="Vide : le même prix." error={memberOk ? null : "Montant invalide"}>
          <input className="input num" inputMode="decimal" value={memberAmount} onChange={(e) => setMemberAmount(e.target.value)} />
        </Field>
      </div>
      {pricing === "fixed" ? null : (
        <Field
          label={pricing === "per_person" ? "Nombre de personnes au plus *" : "Quantité au plus par réservation *"}
          error={maxValue === null ? "Entre 1 et 500." : null}
        >
          <input className="input num" type="number" min={1} max={500} value={maxQuantity} onChange={(e) => setMaxQuantity(e.target.value)} />
        </Field>
      )}
      <label className="row center" style={{ gap: 8 }}>
        <input type="checkbox" className="chk" checked={isPublic} onChange={(e) => setPublic(e.target.checked)} />
        Proposée dans l'espace client
      </label>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

/** Options a client adds to a booking of a type of space, priced per booking, per person or per unit. */
export function ExtrasTab() {
  const client = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Extra | "new" | null>(null);
  const [archiving, setArchiving] = useState<Extra | null>(null);
  const types = useQuery({ queryKey: CW_KEYS.types, queryFn: () => api.get<ResourceType[]>("/coworking/resource-types") });
  const extras = useQuery({ queryKey: CW_KEYS.extras, queryFn: () => api.get<Extra[]>("/coworking/extras") });
  const bookable = (types.data ?? []).filter((t) => isBookableCategory(t.category) && t.status === "active");
  const typeName = new Map((types.data ?? []).map((t) => [t.id, t.name]));
  return (
    <>
      <Card
        title="Options payantes"
        actions={
          <button type="button" className="btn btn-p" disabled={!bookable.length} onClick={() => setEditing("new")}>
            + Option
          </button>
        }
      >
        <ErrorBanner error={extras.error ?? types.error} retry={() => (extras.refetch(), types.refetch())} />
        {extras.isPending || types.isPending ? (
          <Loading />
        ) : !extras.data?.length ? (
          <Empty
            title="Aucune option"
            text="Une option s'ajoute à une réservation : matériel, pause café, place supplémentaire. Son prix s'ajoute au montant à payer."
          />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Option</th>
                  <th>Type d'espace</th>
                  <th>Calcul</th>
                  <th className="num">Prix</th>
                  <th className="num">Abonnés</th>
                  <th>Visibilité</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {extras.data.map((x) => (
                  <tr key={x.id}>
                    <td>
                      <strong>{x.name}</strong>
                    </td>
                    <td>{typeName.get(x.typeId) ?? "Type archivé"}</td>
                    <td>
                      {EXTRA_PRICING[x.pricing]}
                      {x.pricing === "fixed" ? null : <div className="cap">{x.maxQuantity} au plus</div>}
                    </td>
                    <td className="num">
                      <Money value={x.amount} />
                    </td>
                    <td className="num">{x.memberAmount === null ? <span className="cap">même prix</span> : <Money value={x.memberAmount} />}</td>
                    <td>{x.public ? <Badge tone="green">Espace client</Badge> : <Badge tone="gray">Accueil seulement</Badge>}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button type="button" className="btn btn-g" onClick={() => setEditing(x)}>
                        Modifier
                      </button>
                      <button type="button" className="btn btn-g" onClick={() => setArchiving(x)}>
                        Archiver
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing ? <ExtraModal extra={editing === "new" ? null : editing} types={bookable} onClose={() => setEditing(null)} /> : null}
      {archiving ? (
        <ReasonDialog
          title="Archiver l'option"
          explanation={`${archiving.name} n'est plus proposée. Les réservations qui l'ont déjà prise la gardent.`}
          confirmLabel="Archiver"
          onClose={() => setArchiving(null)}
          onConfirm={async (reason) => {
            await api.post(`/coworking/extras/${archiving.id}/archive`, { reason });
            await client.invalidateQueries({ queryKey: CW_KEYS.extras });
            toast("Option archivée.");
          }}
        />
      ) : null}
    </>
  );
}
