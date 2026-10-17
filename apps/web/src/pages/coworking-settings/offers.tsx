import { isBookableCategory } from "@gcf/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, Money, ReasonDialog, Segmented } from "../../components/ui";
import { frDate, percent, tnd, todayIso, tryParseTnd } from "../../lib/format";
import { CW_KEYS, type PackProduct, type Profile, type PromoCode, type ResourceType } from "./api";
import { hoursText, parseHours, parseInteger, parsePercent, percentText } from "./helpers";
import { PlansCard, quotaLabel } from "./plans";

const PROFILE_LABEL: Record<Profile, string> = { visitor: "Visiteurs", member: "Membres" };

function PackModal({ pack, types, onClose }: { pack: PackProduct | null; types: ResourceType[]; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(pack?.name ?? "");
  const [typeId, setTypeId] = useState(pack?.typeId ?? types[0]?.id ?? "");
  const [quotaKind, setQuotaKind] = useState<PackProduct["quotaKind"]>(pack?.quotaKind ?? "bookings");
  const [quota, setQuota] = useState(pack ? (pack.quotaKind === "minutes" ? hoursText(pack.quota) : String(pack.quota)) : "10");
  const [validity, setValidity] = useState(String(pack?.validityDays ?? 90));
  const [price, setPrice] = useState(pack ? tnd(pack.price) : "");
  const [isPublic, setPublic] = useState(pack?.public ?? true);
  const quotaValue = quotaKind === "minutes" ? parseHours(quota) : parseInteger(quota, 1, 1_000_000);
  const validityValue = parseInteger(validity, 1, 1095);
  const priceValue = tryParseTnd(price);
  const valid = name.trim() !== "" && !!typeId && quotaValue !== null && validityValue !== null && priceValue !== null && priceValue > 0;
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), typeId, quotaKind, quota: quotaValue, validityDays: validityValue, price: priceValue, public: isPublic };
      return pack ? api.patch(`/coworking/pack-products/${pack.id}`, body) : api.post("/coworking/pack-products", body);
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: CW_KEYS.packs });
      toast(pack ? "Pack modifié. Les packs déjà vendus gardent leurs conditions." : "Pack créé.");
      onClose();
    },
  });
  return (
    <Modal
      title={pack ? `Modifier ${pack.name}` : "Nouveau pack"}
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
      <Field label="Nom *" hint="Par exemple : Carnet 10 journées, Pack 20 heures de salle.">
        <input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Type d'espace *">
        <select className="input" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="stack" style={{ gap: 6 }}>
        <span className="lab">Contenu</span>
        <Segmented
          label="Contenu du pack"
          value={quotaKind}
          onChange={setQuotaKind}
          options={[
            { value: "bookings", label: "Réservations" },
            { value: "minutes", label: "Heures" },
          ]}
        />
      </div>
      <div className="grid2">
        <Field
          label={quotaKind === "minutes" ? "Nombre d'heures *" : "Nombre de réservations *"}
          error={quotaValue === null ? (quotaKind === "minutes" ? "Un nombre d'heures positif." : "Un nombre entier positif.") : null}
        >
          <input className="input num" inputMode="decimal" value={quota} onChange={(e) => setQuota(e.target.value)} />
        </Field>
        <Field label="Validité (jours) *" hint="À compter de l'achat." error={validityValue === null ? "Entre 1 et 1095 jours." : null}>
          <input className="input num" type="number" min={1} max={1095} value={validity} onChange={(e) => setValidity(e.target.value)} />
        </Field>
      </div>
      <Field label="Prix (TND) *" error={price.trim() && (priceValue === null || priceValue <= 0) ? "Montant invalide" : null}>
        <input className="input num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
      </Field>
      <label className="row center" style={{ gap: 8 }}>
        <input type="checkbox" className="chk" checked={isPublic} onChange={(e) => setPublic(e.target.checked)} />
        Visible sur le site et dans l'espace client
      </label>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

function PacksCard({ types }: { types: ResourceType[] }) {
  const client = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<PackProduct | "new" | null>(null);
  const [archiving, setArchiving] = useState<PackProduct | null>(null);
  const packs = useQuery({ queryKey: CW_KEYS.packs, queryFn: () => api.get<PackProduct[]>("/coworking/pack-products") });
  const bookable = types.filter((t) => isBookableCategory(t.category));
  const typeName = new Map(types.map((t) => [t.id, t.name]));
  return (
    <>
      <Card
        title="Packs prépayés"
        actions={
          <button type="button" className="btn btn-p" disabled={!bookable.length} onClick={() => setEditing("new")}>
            + Pack
          </button>
        }
      >
        <ErrorBanner error={packs.error} retry={() => packs.refetch()} />
        {packs.isPending ? (
          <Loading />
        ) : !packs.data?.length ? (
          <Empty title="Aucun pack" text="Un pack vend à l'avance des heures ou des réservations sur un type d'espace, valables un temps donné." />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Pack</th>
                  <th>Type d'espace</th>
                  <th>Contenu</th>
                  <th className="num">Validité</th>
                  <th className="num">Prix</th>
                  <th>Visibilité</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {packs.data.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.name}</strong>
                    </td>
                    <td>{typeName.get(p.typeId) ?? "Type archivé"}</td>
                    <td>{quotaLabel(p.quotaKind, p.quota)}</td>
                    <td className="num">{p.validityDays} jours</td>
                    <td className="num">
                      <Money value={p.price} />
                    </td>
                    <td>{p.public ? <Badge tone="green">Public</Badge> : <Badge tone="gray">Interne</Badge>}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button type="button" className="btn btn-g" disabled={!bookable.length} onClick={() => setEditing(p)}>
                        Modifier
                      </button>
                      <button type="button" className="btn btn-g" onClick={() => setArchiving(p)}>
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
      {editing ? <PackModal pack={editing === "new" ? null : editing} types={bookable} onClose={() => setEditing(null)} /> : null}
      {archiving ? (
        <ReasonDialog
          title="Archiver le pack"
          explanation={`${archiving.name} n'est plus vendu. Les packs déjà achetés restent utilisables jusqu'à leur expiration.`}
          confirmLabel="Archiver"
          onClose={() => setArchiving(null)}
          onConfirm={async (reason) => {
            await api.post(`/coworking/pack-products/${archiving.id}/archive`, { reason });
            await client.invalidateQueries({ queryKey: CW_KEYS.packs });
            toast("Pack archivé.");
          }}
        />
      ) : null}
    </>
  );
}

function PromoModal({ promo, onClose }: { promo: PromoCode | null; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const today = todayIso();
  const [code, setCode] = useState(promo?.code ?? "");
  const [kind, setKind] = useState<PromoCode["kind"]>(promo?.kind ?? "percent");
  const [value, setValue] = useState(promo ? (promo.kind === "percent" ? percentText(promo.value) : tnd(promo.value)) : "");
  const [validFrom, setValidFrom] = useState(promo?.validFrom ?? today);
  const [validTo, setValidTo] = useState(promo?.validTo ?? today);
  const [maxUses, setMaxUses] = useState(promo?.maxUses ? String(promo.maxUses) : "");
  const [profiles, setProfiles] = useState<Profile[]>(promo?.profiles ?? ["visitor", "member"]);
  const codeOk = /^[A-Z0-9-]{3,30}$/.test(code.trim());
  const valueParsed = kind === "percent" ? parsePercent(value) : tryParseTnd(value);
  const valueOk = valueParsed !== null && valueParsed > 0;
  const maxUsesValue = maxUses.trim() === "" ? null : parseInteger(maxUses, 1, 1_000_000);
  const errors = {
    code: code.trim() && !codeOk ? "3 à 30 lettres, chiffres ou tirets." : null,
    value: value.trim() && !valueOk ? (kind === "percent" ? "Un pourcentage entre 0,01 et 100." : "Montant invalide") : null,
    dates: !validFrom || !validTo || validTo < validFrom ? "La fin ne peut pas précéder le début." : null,
    maxUses: maxUses.trim() && maxUsesValue === null ? "Un nombre entier positif, ou vide." : null,
    profiles: profiles.length ? null : "Choisissez au moins un profil.",
  };
  const valid = codeOk && valueOk && Object.values(errors).every((e) => e === null);
  const save = useMutation({
    mutationFn: () => {
      const body = { code: code.trim(), kind, value: valueParsed, validFrom, validTo, maxUses: maxUsesValue, profiles };
      return promo ? api.patch(`/coworking/promo-codes/${promo.id}`, body) : api.post("/coworking/promo-codes", body);
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: CW_KEYS.promos });
      toast(promo ? "Code promotionnel modifié." : "Code promotionnel créé.");
      onClose();
    },
  });
  return (
    <Modal
      title={promo ? `Modifier ${promo.code}` : "Nouveau code promotionnel"}
      onClose={onClose}
      footer={
        <>
          <span className="cap">La remise s'applique après les droits d'abonnement et les packs</span>
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
      <Field label="Code *" hint="Saisi par le client lors de la réservation, par exemple RENTREE26." error={errors.code}>
        <input className="input" value={code} maxLength={30} onChange={(e) => setCode(e.target.value.toUpperCase())} />
      </Field>
      <div className="stack" style={{ gap: 6 }}>
        <span className="lab">Remise</span>
        <Segmented
          label="Nature de la remise"
          value={kind}
          onChange={(k) => {
            setKind(k);
            setValue("");
          }}
          options={[
            { value: "percent", label: "Pourcentage" },
            { value: "amount", label: "Montant fixe" },
          ]}
        />
      </div>
      <Field label={kind === "percent" ? "Pourcentage (%) *" : "Montant (TND) *"} error={errors.value}>
        <input className="input num" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <div className="grid2">
        <Field label="Valable du *">
          <input className="input" type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
        </Field>
        <Field label="Au (inclus) *" error={errors.dates}>
          <input className="input" type="date" value={validTo} min={validFrom} onChange={(e) => setValidTo(e.target.value)} />
        </Field>
      </div>
      <Field label="Utilisations maximum" hint="Vide : sans limite. Les réservations refusées, expirées ou annulées ne comptent pas." error={errors.maxUses}>
        <input className="input num" type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
      </Field>
      <fieldset className="stack" style={{ border: 0, margin: 0, padding: 0, gap: 6 }}>
        <legend className="lab" style={{ marginBottom: 6 }}>
          Clients concernés
        </legend>
        <div className="row" style={{ gap: 12 }}>
          {(Object.keys(PROFILE_LABEL) as Profile[]).map((p) => (
            <label key={p} className="row center" style={{ gap: 6 }}>
              <input
                type="checkbox"
                className="chk"
                checked={profiles.includes(p)}
                onChange={(e) => setProfiles(e.target.checked ? [...profiles, p] : profiles.filter((x) => x !== p))}
              />
              {PROFILE_LABEL[p]}
            </label>
          ))}
        </div>
        {errors.profiles ? <span className="err-text">{errors.profiles}</span> : null}
      </fieldset>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

function promoState(p: PromoCode, today: string) {
  if (p.maxUses !== null && p.uses >= p.maxUses) return <Badge tone="gray">Épuisé</Badge>;
  if (today < p.validFrom) return <Badge tone="blue">À venir</Badge>;
  if (today > p.validTo) return <Badge tone="gray">Expiré</Badge>;
  return <Badge tone="green">Actif</Badge>;
}

function PromosCard() {
  const client = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<PromoCode | "new" | null>(null);
  const [archiving, setArchiving] = useState<PromoCode | null>(null);
  const promos = useQuery({ queryKey: CW_KEYS.promos, queryFn: () => api.get<PromoCode[]>("/coworking/promo-codes") });
  const today = todayIso();
  return (
    <>
      <Card
        title="Codes promotionnels"
        actions={
          <button type="button" className="btn btn-p" onClick={() => setEditing("new")}>
            + Code
          </button>
        }
      >
        <ErrorBanner error={promos.error} retry={() => promos.refetch()} />
        {promos.isPending ? (
          <Loading />
        ) : !promos.data?.length ? (
          <Empty title="Aucun code promotionnel" />
        ) : (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Code</th>
                  <th className="num">Remise</th>
                  <th>Validité</th>
                  <th>Clients</th>
                  <th className="num">Utilisations</th>
                  <th>État</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {promos.data.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.code}</strong>
                    </td>
                    <td className="num">{p.kind === "percent" ? percent(p.value) : <Money value={p.value} />}</td>
                    <td>
                      Du {frDate(p.validFrom)} au {frDate(p.validTo)}
                    </td>
                    <td>{p.profiles.map((x) => PROFILE_LABEL[x]).join(", ")}</td>
                    <td className="num">
                      {p.uses}
                      {p.maxUses !== null ? ` / ${p.maxUses}` : ""}
                    </td>
                    <td>{promoState(p, today)}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button type="button" className="btn btn-g" onClick={() => setEditing(p)}>
                        Modifier
                      </button>
                      <button type="button" className="btn btn-g" onClick={() => setArchiving(p)}>
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
      {editing ? <PromoModal promo={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
      {archiving ? (
        <ReasonDialog
          title="Archiver le code promotionnel"
          explanation={`${archiving.code} n'est plus accepté pour les nouvelles réservations. Les réservations qui l'ont utilisé gardent leur remise.`}
          confirmLabel="Archiver"
          onClose={() => setArchiving(null)}
          onConfirm={async (reason) => {
            await api.post(`/coworking/promo-codes/${archiving.id}/archive`, { reason });
            await client.invalidateQueries({ queryKey: CW_KEYS.promos });
            toast("Code promotionnel archivé.");
          }}
        />
      ) : null}
    </>
  );
}

/** What the coworking sells besides single bookings: subscription plans, prepaid packs and promotion codes. */
export function OffersTab() {
  const types = useQuery({ queryKey: CW_KEYS.types, queryFn: () => api.get<ResourceType[]>("/coworking/resource-types") });
  if (types.error) return <ErrorBanner error={types.error} retry={() => types.refetch()} />;
  if (types.isPending) return <Loading />;
  return (
    <>
      <PlansCard types={types.data} />
      <PacksCard types={types.data} />
      <PromosCard />
    </>
  );
}
